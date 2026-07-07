import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { AppModule } from '../app.module';
import { OutboxService } from '../modules/outbox/outbox.service';
import { SweepService } from '../modules/queue/sweep.service';
import {
  EVENTS_QUEUE,
  EVENTS_JOB_OPTIONS,
  SWEEP_QUEUE,
  SWEEP_JOB_OPTIONS,
  redisConnectionOptions,
} from '../modules/queue/queue.constants';

const RELAY_INTERVAL_MS = 2_000;
const SWEEP_EVERY_MS = 60_000;

/**
 * Process THỨ HAI của cùng codebase (AD-9): gọi service module chủ IN-PROCESS qua DI —
 * KHÔNG HTTP nội bộ, KHÔNG token worker. Nhiệm vụ: relay outbox → BullMQ + sweep định kỳ.
 * CHƯA có consumer gửi mail (Epic 5) — EVENTS worker mới là baseline (ack + log).
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Worker');
  const connection = redisConnectionOptions(process.env.REDIS_URL);
  if (!connection) {
    throw new Error('Worker cần REDIS_URL — không khởi động (AD-9).');
  }

  // App context KHÔNG mở HTTP (createApplicationContext) — chỉ DI để gọi service.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const outbox = app.get(OutboxService);
  const sweep = app.get(SweepService);

  // defaultJobOptions → mọi job relay add đều thừa hưởng attempts/backoff/retention (AD-9).
  const eventsQueue = new Queue(EVENTS_QUEUE, {
    connection,
    defaultJobOptions: EVENTS_JOB_OPTIONS,
  });
  const sweepQueue = new Queue(SWEEP_QUEUE, { connection });

  // EVENTS worker — baseline: đọc lại theo id từ DB rồi xử (Epic 5 gắn consumer mail).
  const eventsWorker = new Worker(
    EVENTS_QUEUE,
    (job: Job) => {
      const data = job.data as { id?: string };
      logger.log(`event '${job.name}' id=${data?.id ?? '?'} (baseline ack)`);
      return Promise.resolve();
    },
    { connection },
  );
  eventsWorker.on('failed', (job, err) => {
    logger.error(`EVENTS job ${job?.id} cạn retry → DLQ: ${err.message}`);
  });

  // SWEEP worker — chạy mọi handler đã đăng ký (registry rỗng ở 3.5a).
  const sweepWorker = new Worker(
    SWEEP_QUEUE,
    async () => {
      await sweep.runAll();
    },
    { connection },
  );
  sweepWorker.on('failed', (job, err) => {
    logger.error(`SWEEP job ${job?.id} lỗi: ${err.message}`);
  });

  // Sweep repeatable ~60s (jobId cố định → không chồng lịch khi restart).
  await sweepQueue.add(
    'tick',
    {},
    {
      ...SWEEP_JOB_OPTIONS,
      repeat: { every: SWEEP_EVERY_MS },
      jobId: 'sweep-tick',
    },
  );

  // Relay outbox → EVENTS mỗi RELAY_INTERVAL_MS (Redis chết thì event dồn ở Postgres,
  // relay bù khi sống lại — không mất nghiệp vụ).
  const relayTimer = setInterval(() => {
    void outbox
      .relayBatch(eventsQueue)
      .catch((e) => logger.error(`relay lỗi: ${(e as Error).message}`));
  }, RELAY_INTERVAL_MS);

  logger.log(
    `Worker sẵn sàng — relay ${RELAY_INTERVAL_MS}ms, sweep ${SWEEP_EVERY_MS}ms, sweep handlers=${sweep.registeredCount}`,
  );

  const shutdown = async (): Promise<void> => {
    clearInterval(relayTimer);
    await eventsWorker.close();
    await sweepWorker.close();
    await eventsQueue.close();
    await sweepQueue.close();
    await app.close();
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

void bootstrap();
