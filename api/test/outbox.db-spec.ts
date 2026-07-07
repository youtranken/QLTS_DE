import { join } from 'node:path';
import { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import { OutboxService } from '../src/modules/outbox/outbox.service';
import {
  EVENTS_JOB_OPTIONS,
  redisConnectionOptions,
} from '../src/modules/queue/queue.constants';

/**
 * Story 3.5a — outbox + relay (AD-11). Postgres cho tx/claim; Redis container cho BullMQ.
 * REDIS_TEST_URL mặc định trỏ container qlts-test-redis (port 63799, pass 'test').
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[outbox.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[outbox.db-spec] Từ chối chạy trên '${dbName}'.`);
}
const REDIS_TEST_URL =
  process.env.REDIS_TEST_URL ?? 'redis://:test@127.0.0.1:63799';

describe('Outbox + relay (story 3.5a)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let service: OutboxService;
  let queue: Queue;
  const QUEUE_NAME = 'qlts-test-events';

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    db = drizzle(pool);
    service = new OutboxService(db);
    const connection = redisConnectionOptions(REDIS_TEST_URL);
    // defaultJobOptions như production → test khẳng định attempts/backoff (H1 review)
    queue = new Queue(QUEUE_NAME, {
      connection: connection!,
      defaultJobOptions: EVENTS_JOB_OPTIONS,
    });
    await queue.obliterate({ force: true }); // sạch trước test
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM outbox');
    await queue.obliterate({ force: true });
  });

  it('enqueueWithin ghi outbox TRONG transaction nghiệp vụ (AC 2)', async () => {
    await db.transaction(async (tx) => {
      await service.enqueueWithin(tx, 'ticket.created', { ticketId: 't-1' });
    });
    const rows = await pool.query(
      `SELECT topic, payload, claimed_at FROM outbox`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].topic).toBe('ticket.created');
    expect(rows.rows[0].payload).toEqual({ ticketId: 't-1' });
    expect(rows.rows[0].claimed_at).toBeNull();
  });

  it('enqueueWithin rollback theo tx nghiệp vụ — outbox KHÔNG ghi khi tx fail (AC 2)', async () => {
    await expect(
      db.transaction(async (tx) => {
        await service.enqueueWithin(tx, 'ticket.created', { ticketId: 't-x' });
        throw new Error('nghiệp vụ fail');
      }),
    ).rejects.toThrow('nghiệp vụ fail');
    const rows = await pool.query(`SELECT count(*)::int AS n FROM outbox`);
    expect(rows.rows[0].n).toBe(0);
  });

  it('relay claim (FOR UPDATE SKIP LOCKED) → job vào BullMQ, set claimed_at (AC 2)', async () => {
    await db.transaction(async (tx) => {
      await service.enqueueWithin(tx, 'ev.a', { id: 'a' });
    });
    const evRow = await pool.query<{ id: string }>(`SELECT id FROM outbox`);
    const n = await service.relayBatch(queue);
    expect(n).toBe(1);
    // job tồn tại trong queue với jobId = outbox id
    const job = await queue.getJob(evRow.rows[0].id);
    expect(job).toBeTruthy();
    const claimed = await pool.query(`SELECT claimed_at FROM outbox`);
    expect(claimed.rows[0].claimed_at).not.toBeNull();
  });

  it('relay 2 lần KHÔNG sinh job đúp (jobId dedup — AC 2/4)', async () => {
    await db.transaction(async (tx) => {
      await service.enqueueWithin(tx, 'ev.b', {});
    });
    const first = await service.relayBatch(queue);
    // reset claimed_at để ép relay claim lại CÙNG event (mô phỏng crash sau add, trước mark)
    await pool.query(`UPDATE outbox SET claimed_at = NULL`);
    const second = await service.relayBatch(queue);
    expect(first).toBe(1);
    expect(second).toBe(1); // relay chạy lại
    // nhưng job trong queue vẫn CHỈ 1 (jobId dedup)
    const counts = await queue.getJobCounts(
      'waiting',
      'delayed',
      'active',
      'completed',
    );
    const total =
      (counts.waiting ?? 0) +
      (counts.delayed ?? 0) +
      (counts.active ?? 0) +
      (counts.completed ?? 0);
    expect(total).toBe(1);
  });

  it('"Redis chưa relay" nhiều event → relay BÙ claim hết, không mất (AC 4)', async () => {
    for (let i = 0; i < 5; i++) {
      await db.transaction(async (tx) => {
        await service.enqueueWithin(tx, 'ev.batch', { i });
      });
    }
    // trước relay: 5 event chưa claim nằm trong Postgres (Redis chết cũng không mất)
    const before = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE claimed_at IS NULL`,
    );
    expect(before.rows[0].n).toBe(5);
    const relayed = await service.relayBatch(queue);
    expect(relayed).toBe(5);
    const after = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE claimed_at IS NULL`,
    );
    expect(after.rows[0].n).toBe(0);
  });

  it('job events có attempts+backoff (retry→DLQ — AC 1, H1)', async () => {
    await db.transaction(async (tx) => {
      await service.enqueueWithin(tx, 'ev.retry', {});
    });
    const evRow = await pool.query<{ id: string }>(`SELECT id FROM outbox`);
    await service.relayBatch(queue);
    const job = await queue.getJob(evRow.rows[0].id);
    expect(job?.opts.attempts).toBe(5);
    expect(job?.opts.backoff).toMatchObject({ type: 'exponential' });
  });

  it('2 relay SONG SONG claim tập DISJOINT (FOR UPDATE SKIP LOCKED — AC 2)', async () => {
    for (let i = 0; i < 6; i++) {
      await db.transaction(async (tx) => {
        await service.enqueueWithin(tx, 'ev.par', { i });
      });
    }
    const [a, b] = await Promise.all([
      service.relayBatch(queue, 3),
      service.relayBatch(queue, 3),
    ]);
    // Tổng đúng 6, không claim đè (mỗi event chỉ 1 lần) — không mất, không đúp
    expect(a + b).toBe(6);
    const unclaimed = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE claimed_at IS NULL`,
    );
    expect(unclaimed.rows[0].n).toBe(0);
    const counts = await queue.getJobCounts('waiting', 'active', 'completed');
    expect(
      (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.completed ?? 0),
    ).toBe(6);
  });

  it('F1: row đã claim nhưng CHƯA processed + lease hết 5p → relay RE-DRIVE (không nuốt)', async () => {
    await db.transaction(async (tx) => {
      await service.enqueueWithin(tx, 'ev.stranded', { id: 's' });
    });
    const first = await service.relayBatch(queue);
    expect(first).toBe(1);
    // Mô phỏng: job cạn retry/DLQ hoặc Redis mất job — processed_at vẫn NULL, lease cũ >5p
    await pool.query(
      `UPDATE outbox SET claimed_at = now() - interval '10 minutes'`,
    );
    const redrive = await service.relayBatch(queue);
    expect(redrive).toBe(1); // re-drive, KHÔNG kẹt vĩnh viễn (F1)
  });

  it('F1: row ĐÃ processed → relay KHÔNG re-drive (dedup bền)', async () => {
    await db.transaction(async (tx) => {
      await service.enqueueWithin(tx, 'ev.done', { id: 'd' });
    });
    const evRow = await pool.query<{ id: string }>(`SELECT id FROM outbox`);
    await service.relayBatch(queue);
    const marked = await service.markProcessed(evRow.rows[0].id);
    expect(marked).toBe(true);
    // Dù lease hết hạn, đã processed thì không claim lại
    await pool.query(
      `UPDATE outbox SET claimed_at = now() - interval '10 minutes'`,
    );
    const redrive = await service.relayBatch(queue);
    expect(redrive).toBe(0);
    // markProcessed lần 2 = idempotent, trả false (đã xử)
    expect(await service.markProcessed(evRow.rows[0].id)).toBe(false);
  });

  it('F2: markFailed ghi marker DLQ bền (fail_count/last_error) cho dashboard SA', async () => {
    await db.transaction(async (tx) => {
      await service.enqueueWithin(tx, 'ev.fail', { id: 'f' });
    });
    const evRow = await pool.query<{ id: string }>(`SELECT id FROM outbox`);
    await service.markFailed(evRow.rows[0].id, 'SMTP timeout');
    await service.markFailed(evRow.rows[0].id, 'SMTP timeout again');
    const row = await pool.query<{
      fail_count: number;
      last_error: string;
      processed_at: string | null;
    }>(`SELECT fail_count, last_error, processed_at FROM outbox`);
    expect(row.rows[0].fail_count).toBe(2);
    expect(row.rows[0].last_error).toContain('SMTP timeout again');
    expect(row.rows[0].processed_at).toBeNull(); // vẫn re-drive được (backstop)
  });

  it('payload chỉ id/ref — không PII (AC 3, quy ước)', async () => {
    await db.transaction(async (tx) => {
      await service.enqueueWithin(tx, 'ev.ref', {
        ticketId: 't-9',
        bookingId: 'b-9',
      });
    });
    const rows = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox`,
    );
    const raw = JSON.stringify(rows.rows[0].payload);
    // quy ước: chỉ khóa dạng *Id — test canh không lọt email/tên
    expect(raw).not.toMatch(/@/);
    expect(Object.keys(rows.rows[0].payload).every((k) => /Id$/.test(k))).toBe(
      true,
    );
  });
});
