import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import { SystemConfigService } from '../src/modules/config/system-config.service';
import { OutboxService } from '../src/modules/outbox/outbox.service';
import { NotificationsConsumer } from '../src/modules/notifications/notifications.consumer';
import type {
  MailMessage,
  MailTransportService,
} from '../src/modules/notifications/mail-transport.service';

/**
 * Story 5.1 — consumer mail: baseline durable, at-least-once (gửi rồi mới mark), DLQ badge.
 * Chỉ cần Postgres (không đụng Redis — consumer.handle gọi service trực tiếp).
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[notifications-consumer.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(
    `[notifications-consumer.db-spec] Từ chối chạy trên '${dbName}'.`,
  );
}

/** Fake transport: đếm lần gửi, mô phỏng SMTP chết bằng cờ shouldFail. */
class FakeMail {
  sent: MailMessage[] = [];
  shouldFail = false;
  send(msg: MailMessage): Promise<void> {
    if (this.shouldFail) return Promise.reject(new Error('SMTP down'));
    this.sent.push(msg);
    return Promise.resolve();
  }
}

describe('NotificationsConsumer (story 5.1)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let outbox: OutboxService;
  let config: SystemConfigService;
  let mail: FakeMail;
  let consumer: NotificationsConsumer;

  const enqueue = async (topic: string, payload: Record<string, unknown>) => {
    await db.transaction(async (tx) => {
      await outbox.enqueueWithin(tx, topic, payload);
    });
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM outbox ORDER BY created_at DESC LIMIT 1`,
    );
    return r.rows[0].id;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    db = drizzle(pool);
    outbox = new OutboxService(db);
    config = new SystemConfigService(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM outbox');
    await pool.query(
      `DELETE FROM config WHERE key = 'mail_consumer_baseline_at'`,
    );
    mail = new FakeMail();
    consumer = new NotificationsConsumer(
      outbox,
      config,
      mail as unknown as MailTransportService,
    );
  });

  it('baseline ghi MỘT LẦN durable, restart không đè (AC2)', async () => {
    const first = await config.ensureMailConsumerBaseline();
    const second = await config.ensureMailConsumerBaseline();
    expect(second.getTime()).toBe(first.getTime());
  });

  it('event TRƯỚC baseline → mark processed, KHÔNG gửi (AC2)', async () => {
    await consumer.ensureBaseline();
    consumer.register('t.mail', async ({ mail }) => {
      await mail.send({ to: 'a@x', subject: 's' });
    });
    const id = await enqueue('t.mail', { ticketId: 't1' });
    // backdate về trước baseline (tồn đọng build/test Epic 3–4)
    await pool.query(
      `UPDATE outbox SET created_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    await consumer.handle('t.mail', id);
    expect(mail.sent).toHaveLength(0);
    const row = await pool.query<{ processed_at: string | null }>(
      `SELECT processed_at FROM outbox WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].processed_at).not.toBeNull();
  });

  it('event SAU baseline có handler → gửi + processed (AC1)', async () => {
    await consumer.ensureBaseline();
    consumer.register('t.mail', async ({ mail, payload }) => {
      await mail.send({ to: 'a@x', subject: `s-${String(payload.ticketId)}` });
    });
    const id = await enqueue('t.mail', { ticketId: 't2' });
    await consumer.handle('t.mail', id);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toBe('s-t2');
    const row = await pool.query<{ processed_at: string | null }>(
      `SELECT processed_at FROM outbox WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].processed_at).not.toBeNull();
  });

  it('retry SAU processed → KHÔNG gửi lại (at-least-once, AC1)', async () => {
    await consumer.ensureBaseline();
    consumer.register('t.mail', async ({ mail }) => {
      await mail.send({ to: 'a@x', subject: 's' });
    });
    const id = await enqueue('t.mail', {});
    await consumer.handle('t.mail', id);
    await consumer.handle('t.mail', id); // relay chạy lại cùng event
    expect(mail.sent).toHaveLength(1);
  });

  it('topic CHƯA có handler → mark processed, không crash, không gửi', async () => {
    await consumer.ensureBaseline();
    const id = await enqueue('t.unknown', {});
    await consumer.handle('t.unknown', id);
    expect(mail.sent).toHaveLength(0);
    const row = await pool.query<{ processed_at: string | null }>(
      `SELECT processed_at FROM outbox WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].processed_at).not.toBeNull();
  });

  it('SMTP chết → không mark, markFailed đếm; SMTP sống lại → gửi bù, KHÔNG nuốt (AC2/AC3)', async () => {
    await consumer.ensureBaseline();
    consumer.register('t.mail', async ({ mail }) => {
      await mail.send({ to: 'a@x', subject: 's' });
    });
    const id = await enqueue('t.mail', {});
    mail.shouldFail = true;
    await expect(consumer.handle('t.mail', id)).rejects.toThrow('SMTP down');
    // worker on('failed') ghi marker DLQ khi cạn retry
    await outbox.markFailed(id, 'SMTP down');
    let row = await pool.query<{
      fail_count: number;
      processed_at: string | null;
    }>(`SELECT fail_count, processed_at FROM outbox WHERE id = $1`, [id]);
    expect(row.rows[0].fail_count).toBe(1);
    expect(row.rows[0].processed_at).toBeNull(); // CHƯA gửi được → không mark → re-drive
    // SMTP sống lại → relay re-drive gọi lại handle → gửi bù
    mail.shouldFail = false;
    await consumer.handle('t.mail', id);
    expect(mail.sent).toHaveLength(1);
    row = await pool.query<{ fail_count: number; processed_at: string | null }>(
      `SELECT fail_count, processed_at FROM outbox WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].processed_at).not.toBeNull();
  });

  it('listFailed đếm đúng event lỗi chưa xử (badge AC3)', async () => {
    const idA = await enqueue('t.a', {});
    const idB = await enqueue('t.b', {});
    await outbox.markFailed(idA, 'err A');
    await outbox.markFailed(idB, 'err B');
    // B đã xử xong → rời badge
    await outbox.markProcessed(idB);
    const failed = await outbox.listFailed();
    expect(failed.total).toBe(1);
    expect(failed.items[0].id).toBe(idA);
    expect(failed.items[0].lastError).toContain('err A');
  });

  it('requeue reset marker lỗi → relay re-drive (AC3)', async () => {
    const id = await enqueue('t.a', {});
    await outbox.markFailed(id, 'boom');
    const ok = await outbox.requeue(id);
    expect(ok).toBe(true);
    const failed = await outbox.listFailed();
    expect(failed.total).toBe(0); // rời badge
    const row = await pool.query<{
      fail_count: number;
      claimed_at: string | null;
    }>(`SELECT fail_count, claimed_at FROM outbox WHERE id = $1`, [id]);
    expect(row.rows[0].fail_count).toBe(0);
    expect(row.rows[0].claimed_at).toBeNull();
  });
});
