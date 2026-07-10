import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { AppModule } from '../app.module';
import { NotificationsConsumer } from '../modules/notifications/notifications.consumer';
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

/** AD-13f: lỗi SMTP thường nhúng địa chỉ người nhận (vd "550 <user@corp> rejected") — che
 *  email trước khi log/ghi last_error (hiển thị trên dashboard SA). */
function redactPii(message: string): string {
  // TLD tùy chọn (`*`) để che cả email local-domain nội bộ (vd "user@corp" không có dấu chấm).
  return message.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g, '[email]');
}

/**
 * Process THỨ HAI của cùng codebase (AD-9): gọi service module chủ IN-PROCESS qua DI —
 * KHÔNG HTTP nội bộ, KHÔNG token worker. Nhiệm vụ: relay outbox → BullMQ + consumer gửi mail
 * (5.1) + sweep định kỳ.
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
  const notifications = app.get(NotificationsConsumer);

  // Baseline durable MỘT LẦN trước khi nhận job (AC2) — event tồn đọng < baseline không gửi.
  await notifications.ensureBaseline();

  // defaultJobOptions → mọi job relay add đều thừa hưởng attempts/backoff/retention (AD-9).
  const eventsQueue = new Queue(EVENTS_QUEUE, {
    connection,
    defaultJobOptions: EVENTS_JOB_OPTIONS,
  });
  const sweepQueue = new Queue(SWEEP_QUEUE, { connection });

  // EVENTS worker — consumer mail (5.1): đọc lại theo id từ DB, gửi mail THÀNH CÔNG rồi mới
  // markProcessed (at-least-once, AD-11). Gửi lỗi → throw → BullMQ retry → cạn thì on('failed').
  const eventsWorker = new Worker(
    EVENTS_QUEUE,
    async (job: Job) => {
      const data = job.data as { id?: string };
      if (data?.id) await notifications.handle(job.name, data.id);
    },
    { connection },
  );
  // F2: job cạn retry → ghi marker BỀN vào Postgres cho dashboard SA (không chết im lặng).
  // removeOnFail:true (queue.constants) xóa job failed ở BullMQ để relay re-drive được;
  // bằng chứng DLQ nằm ở outbox.fail_count/last_error (Postgres là bộ nhớ, Redis là đồng hồ).
  // BullMQ phát 'failed' MỖI attempt (kể cả retry trung gian) — chỉ ghi DLQ khi CẠN retry,
  // nếu không fail_count phồng +attempts mỗi chu kỳ và log "cạn retry" sai (review 5.1 M1).
  eventsWorker.on('failed', (job, err) => {
    const made = job?.attemptsMade ?? 0;
    const max = job?.opts.attempts ?? 1;
    const reason = redactPii(err.message);
    if (made < max) {
      logger.warn(
        `EVENTS job ${job?.id} attempt ${made}/${max} lỗi: ${reason}`,
      );
      return;
    }
    const id = (job?.data as { id?: string })?.id;
    logger.error(`EVENTS job ${job?.id} cạn retry → DLQ: ${reason}`);
    // markFailed fire-and-forget: PHẢI .catch (như relayTimer) — reject không bắt sẽ thành
    // unhandledRejection có thể hạ tiến trình worker + mất marker DLQ (review P0 3.3).
    if (id)
      void outbox
        .markFailed(id, reason)
        .catch((e) =>
          logger.error(`markFailed lỗi: ${(e as Error).message}`),
        );
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
