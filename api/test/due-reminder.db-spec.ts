import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import { OutboxService } from '../src/modules/outbox/outbox.service';
import { SystemConfigService } from '../src/modules/config/system-config.service';
import { DueReminderService } from '../src/modules/tickets/due-reminder.service';
import { NotificationsConsumer } from '../src/modules/notifications/notifications.consumer';
import { NotificationRecipientsService } from '../src/modules/notifications/notification-recipients.service';
import { DueReminderMailRegistrar } from '../src/modules/notifications/due-reminder-mail.registrar';
import type {
  MailMessage,
  MailTransportService,
} from '../src/modules/notifications/mail-transport.service';

/** Mail "tới hạn trả" — 1 mail đúng lúc buổi mượn hết hạn. Chỉ cần Postgres. */
if (!process.env.DATABASE_URL) {
  throw new Error('[due-reminder.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[due-reminder.db-spec] Từ chối chạy trên '${dbName}'.`);
}

class FakeMail {
  sent: MailMessage[] = [];
  send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
}

describe('Due reminder mail (tới hạn trả)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let outbox: OutboxService;
  let config: SystemConfigService;
  let due: DueReminderService;
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

  const insertTicket = async (state: string, borrower: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub)
       VALUES ('normal', $1, $2, $2) RETURNING id`,
      [state, borrower],
    );
    return r.rows[0].id;
  };

  /** Booking [now+fromH giờ, now+toH giờ). toH<0 ⇒ đã tới hạn (upper<=now). */
  const insertBooking = async (
    ticketId: string,
    assetId: string,
    state: string,
    fromH: number,
    toH: number,
  ) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1, $2, 'normal', $3,
         tstzrange(now() + ($4 || ' hours')::interval, now() + ($5 || ' hours')::interval, '[)'))
       RETURNING id`,
      [ticketId, assetId, state, fromH, toH],
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
    due = new DueReminderService(db, outbox);
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

  it('buổi delivered đã tới hạn → phát due_reminder + set marker', async () => {
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-DUE1');
    const id = await insertTicket('in_use', 'b1');
    const bk = await insertBooking(id, asset, 'delivered', -48, -1); // 2 ngày, upper đã qua
    const n = await due.emitDueReminders();
    expect(n).toBe(1);
    const ob = await pool.query(
      `SELECT payload FROM outbox WHERE topic='due_reminder'`,
    );
    expect(ob.rowCount).toBe(1);
    expect(ob.rows[0].payload).toEqual({ bookingId: bk, ticketId: id });
    const mk = await pool.query<{ d: string | null }>(
      `SELECT due_notified_at::text AS d FROM booking WHERE id=$1`,
      [bk],
    );
    expect(mk.rows[0].d).not.toBeNull();
  });

  it('sweep lại → không phát lại (đã có marker)', async () => {
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-DUE2');
    const id = await insertTicket('in_use', 'b1');
    await insertBooking(id, asset, 'delivered', -48, -1);
    expect(await due.emitDueReminders()).toBe(1);
    expect(await due.emitDueReminders()).toBe(0);
  });

  it('mượn CÙNG NGÀY (nhận=trả cùng ngày VN) → KHÔNG gửi mail tới hạn', async () => {
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-SAMEDAY');
    const id = await insertTicket('in_use', 'b1');
    // Buổi trong HÔM NAY giờ VN: [đầu ngày VN, now) — cùng 1 ngày VN, đã tới hạn.
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1, $2, 'normal', 'delivered',
         tstzrange(
           date_trunc('day', now() AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh',
           now(), '[)'))`,
      [id, asset],
    );
    expect(await due.emitDueReminders()).toBe(0);
  });

  it('buổi CHƯA tới hạn (upper>now) → không phát', async () => {
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-DUE3');
    const id = await insertTicket('in_use', 'b1');
    await insertBooking(id, asset, 'delivered', -1, 48); // upper = now+48h
    expect(await due.emitDueReminders()).toBe(0);
  });

  it('ticket không còn in_use → không phát (đã trả/close)', async () => {
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-DUE4');
    const id = await insertTicket('closed', 'b1');
    await insertBooking(id, asset, 'delivered', -48, -1);
    expect(await due.emitDueReminders()).toBe(0);
  });

  // ---- handler ----
  const buildConsumer = (mail: FakeMail) => {
    const consumer = new NotificationsConsumer(
      outbox,
      config,
      mail as unknown as MailTransportService,
      { isEnabled: async () => true } as unknown as ConstructorParameters<
        typeof NotificationsConsumer
      >[3],
    );
    new DueReminderMailRegistrar(consumer, recipients, db).onModuleInit();
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

  it('handler → mail Admin + người mượn, nêu máy đến hạn', async () => {
    await insertUser('admin1', 'admin', 'admin@x.vn');
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-D10');
    const id = await insertTicket('in_use', 'b1');
    const bk = await insertBooking(id, asset, 'delivered', -2, -1);
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    const evId = await enqueue('due_reminder', { bookingId: bk, ticketId: id });
    await consumer.handle('due_reminder', evId);
    expect(mail.sent).toHaveLength(1);
    expect(new Set(mail.sent[0].to as string[])).toEqual(
      new Set(['admin@x.vn', 'b1@x.vn']),
    );
    expect(mail.sent[0].text ?? '').toContain('MAY-D10');
  });

  it('handler skip khi buổi đã trả (returned) — không mail lỗi thời', async () => {
    await insertUser('admin1', 'admin', 'admin@x.vn');
    await insertUser('b1', 'member', 'b1@x.vn');
    const asset = await insertAsset('MAY-D11');
    const id = await insertTicket('in_use', 'b1');
    const bk = await insertBooking(id, asset, 'returned', -2, -1);
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    const evId = await enqueue('due_reminder', { bookingId: bk, ticketId: id });
    await consumer.handle('due_reminder', evId);
    expect(mail.sent).toHaveLength(0);
  });
});
