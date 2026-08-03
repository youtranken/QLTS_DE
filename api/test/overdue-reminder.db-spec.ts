import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import { OutboxService } from '../src/modules/outbox/outbox.service';
import { SystemConfigService } from '../src/modules/config/system-config.service';
import { OverdueReminderService } from '../src/modules/tickets/overdue-reminder.service';
import { NotificationsConsumer } from '../src/modules/notifications/notifications.consumer';
import { NotificationRecipientsService } from '../src/modules/notifications/notification-recipients.service';
import { OverdueMailRegistrar } from '../src/modules/notifications/overdue-mail.registrar';
import type {
  MailMessage,
  MailTransportService,
} from '../src/modules/notifications/mail-transport.service';

/** Story 5.3 — sweep mail quá hạn + handler overdue/pickup. Chỉ cần Postgres. */
if (!process.env.DATABASE_URL) {
  throw new Error('[overdue-reminder.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[overdue-reminder.db-spec] Từ chối chạy trên '${dbName}'.`);
}

class FakeMail {
  sent: MailMessage[] = [];
  send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
}

describe('Overdue reminder + pickup mail (story 5.3)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let outbox: OutboxService;
  let config: SystemConfigService;
  let overdue: OverdueReminderService;
  let recipients: NotificationRecipientsService;

  const insertUser = (sub: string, role: string, email: string | null) =>
    pool.query(
      `INSERT INTO users (sub, email, role, status) VALUES ($1, $2, $3, 'active')`,
      [sub, email, role],
    );

  const insertAsset = async (code: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, status, is_pool) VALUES ($1, 'laptop', 'in_use', true) RETURNING id`,
      [code],
    );
    return r.rows[0].id;
  };

  const insertTicket = async (
    state: string,
    isOverdue: boolean,
    borrower: string,
    kind = 'normal',
  ) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub, is_overdue)
       VALUES ($1, $2, $3, $3, $4) RETURNING id`,
      [kind, state, borrower, isOverdue],
    );
    return r.rows[0].id;
  };

  /** Booking với period tương đối now: [now+fromH giờ, now+toH giờ). */
  const insertBooking = (
    ticketId: string,
    assetId: string,
    state: string,
    fromH: number,
    toH: number,
  ) =>
    pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1, $2, 'normal', $3,
         tstzrange(now() + ($4 || ' hours')::interval, now() + ($5 || ' hours')::interval, '[)'))`,
      [ticketId, assetId, state, fromH, toH],
    );

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
    overdue = new OverdueReminderService(db, outbox);
    recipients = new NotificationRecipientsService(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM outbox');
    await pool.query('DELETE FROM booking');
    await pool.query('DELETE FROM ticket');
    await pool.query('DELETE FROM assets');
    await pool.query('DELETE FROM users');
    await pool.query(
      `DELETE FROM config WHERE key = 'mail_consumer_baseline_at'`,
    );
    config.clearCache();
  });

  it('ticket in_use quá hạn → phát overdue_reminder + set marker (AC1)', async () => {
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-OV1');
    const id = await insertTicket('in_use', true, 'b1');
    await insertBooking(id, asset, 'delivered', -48, -24); // buổi thực quá hạn
    const n = await overdue.emitOverdueReminders();
    expect(n).toBe(1);
    const ob = await pool.query(
      `SELECT payload FROM outbox WHERE topic='overdue_reminder'`,
    );
    expect(ob.rowCount).toBe(1);
    expect(ob.rows[0].payload).toEqual({ ticketId: id });
    const mk = await pool.query<{ d: string | null }>(
      `SELECT overdue_reminder_date::text AS d FROM ticket WHERE id=$1`,
      [id],
    );
    expect(mk.rows[0].d).not.toBeNull();
  });

  it('sweep lại cùng ngày → không phát lại; ngày VN mới → phát lại', async () => {
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-OV2');
    const id = await insertTicket('in_use', true, 'b1');
    await insertBooking(id, asset, 'delivered', -48, -24);
    expect(await overdue.emitOverdueReminders()).toBe(1);
    expect(await overdue.emitOverdueReminders()).toBe(0);
    await pool.query(
      `UPDATE ticket SET overdue_reminder_date = (now() - interval '1 day')::date WHERE id=$1`,
      [id],
    );
    expect(await overdue.emitOverdueReminders()).toBe(1);
  });

  it('ticket closed / không cờ → không candidate (dừng sau close)', async () => {
    await insertUser('b1', 'member', 'b1@x.vn');
    await insertTicket('closed', false, 'b1');
    await insertTicket('in_use', false, 'b1'); // in_use nhưng chưa quá hạn
    expect(await overdue.emitOverdueReminders()).toBe(0);
  });

  it('cờ is_overdue stale nhưng KHÔNG buổi nào thực quá hạn → không đốt marker (review M1)', async () => {
    // Chuỗi định kỳ: buổi đã trả (returned) để lại is_overdue stale; không buổi delivered
    // nào còn quá hạn → sweep KHÔNG phát, marker KHÔNG bị tiêu (buổi sau trong ngày vẫn nhắc được).
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-OV3');
    const id = await insertTicket('in_use', true, 'b1', 'recurring');
    await insertBooking(id, asset, 'returned', -48, -24); // đã trả, không tính quá hạn
    expect(await overdue.emitOverdueReminders()).toBe(0);
    const mk = await pool.query<{ d: string | null }>(
      `SELECT overdue_reminder_date::text AS d FROM ticket WHERE id=$1`,
      [id],
    );
    expect(mk.rows[0].d).toBeNull(); // marker chưa bị đốt
  });

  // ---- handlers ----
  const buildConsumer = (mail: FakeMail) => {
    const consumer = new NotificationsConsumer(
      outbox,
      config,
      mail as unknown as MailTransportService,
      { isEnabled: async () => true } as unknown as ConstructorParameters<
        typeof NotificationsConsumer
      >[3],
    );
    new OverdueMailRegistrar(consumer, recipients, db).onModuleInit();
    return consumer;
  };

  const enqueue = async (topic: string, payload: Record<string, unknown>) => {
    await db.transaction(async (tx) => {
      await outbox.enqueueWithin(tx, topic, payload);
    });
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM outbox ORDER BY created_at DESC LIMIT 1`,
    );
    return r.rows[0].id;
  };

  it('overdue handler → mail Admin + người mượn, nêu ĐÚNG buổi quá hạn (AC1/AC2)', async () => {
    await insertUser('admin1', 'admin', 'admin@x.vn');
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-01');
    const id = await insertTicket('in_use', true, 'b1', 'recurring');
    // 2 buổi quá hạn (delivered, upper<now) + 1 buổi CHƯA quá hạn (upper>now) → chỉ 2 buổi lên mail
    await insertBooking(id, asset, 'delivered', -72, -48);
    await insertBooking(id, asset, 'delivered', -48, -24);
    await insertBooking(id, asset, 'delivered', -1, 48);
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    const evId = await enqueue('overdue_reminder', { ticketId: id });
    await consumer.handle('overdue_reminder', evId);
    expect(mail.sent).toHaveLength(1);
    expect(new Set(mail.sent[0].to as string[])).toEqual(
      new Set(['admin@x.vn', 'b1@x.vn']),
    );
    const body = mail.sent[0].text ?? '';
    expect((body.match(/Máy MAY-01/g) ?? []).length).toBe(2); // đúng 2 buổi quá hạn
  });

  it('overdue handler skip khi ticket đã close (mark processed, AC1)', async () => {
    await insertUser('admin1', 'admin', 'admin@x.vn');
    await insertUser('b1', 'member', 'b1@x.vn');
    const id = await insertTicket('closed', false, 'b1');
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    const evId = await enqueue('overdue_reminder', { ticketId: id });
    await consumer.handle('overdue_reminder', evId);
    expect(mail.sent).toHaveLength(0);
    const ob = await pool.query<{ processed_at: string | null }>(
      `SELECT processed_at FROM outbox WHERE id=$1`,
      [evId],
    );
    expect(ob.rows[0].processed_at).not.toBeNull();
  });

  it('pickup_reminder handler → mail Admin khi booking chưa giao (AC3)', async () => {
    await insertUser('admin1', 'admin', 'admin@x.vn');
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-02');
    const id = await insertTicket('awaiting_pickup', false, 'b1');
    await insertBooking(id, asset, 'held', -1, 48);
    const bk = await pool.query<{ id: string }>(
      `SELECT id FROM booking WHERE ticket_id=$1`,
      [id],
    );
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    const evId = await enqueue('pickup_reminder', {
      ticketId: id,
      bookingId: bk.rows[0].id,
    });
    await consumer.handle('pickup_reminder', evId);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(['admin@x.vn']);
    expect(mail.sent[0].text).toContain('MAY-02');
  });

  it('pickup_reminder skip khi booking đã delivered (không nhắc lỗi thời, AC3)', async () => {
    await insertUser('admin1', 'admin', 'admin@x.vn');
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-03');
    const id = await insertTicket('in_use', false, 'b1');
    await insertBooking(id, asset, 'delivered', -1, 48);
    const bk = await pool.query<{ id: string }>(
      `SELECT id FROM booking WHERE ticket_id=$1`,
      [id],
    );
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    const evId = await enqueue('pickup_reminder', {
      ticketId: id,
      bookingId: bk.rows[0].id,
    });
    await consumer.handle('pickup_reminder', evId);
    expect(mail.sent).toHaveLength(0);
  });
});
