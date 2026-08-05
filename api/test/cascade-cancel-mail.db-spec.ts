import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import { OutboxService } from '../src/modules/outbox/outbox.service';
import { SystemConfigService } from '../src/modules/config/system-config.service';
import { NotificationsConsumer } from '../src/modules/notifications/notifications.consumer';
import { CascadeCancelMailRegistrar } from '../src/modules/notifications/cascade-cancel-mail.registrar';
import type {
  MailMessage,
  MailTransportService,
} from '../src/modules/notifications/mail-transport.service';

/** Story 5.4 — mail booking bị hủy do máy khóa/gỡ pool/thanh lý. Chỉ cần Postgres. */
if (!process.env.DATABASE_URL) {
  throw new Error('[cascade-cancel-mail.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(
    `[cascade-cancel-mail.db-spec] Từ chối chạy trên '${dbName}'.`,
  );
}

class FakeMail {
  sent: MailMessage[] = [];
  send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
}

describe('Cascade cancel mail (story 5.4)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let outbox: OutboxService;
  let config: SystemConfigService;

  const insertUser = (sub: string, email: string | null) =>
    pool.query(
      `INSERT INTO users (sub, email, role, status) VALUES ($1, $2, 'member', 'active')`,
      [sub, email],
    );

  const insertAsset = async (code: string, status: string, isPool: boolean) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, status, is_pool) VALUES ($1, 'laptop', $2, $3) RETURNING id`,
      [code, status, isPool],
    );
    return r.rows[0].id;
  };

  /** Ticket + booking đã cancelled (non-occupying → không kích bookability trigger). */
  const insertCancelledBooking = async (borrower: string, assetId: string) => {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub)
       VALUES ('normal', 'cancelled', $1, $1) RETURNING id`,
      [borrower],
    );
    const ticketId = t.rows[0].id;
    const b = await pool.query<{ id: string }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1, $2, 'normal', 'cancelled',
         tstzrange(now() + interval '1 day', now() + interval '2 days', '[)'))
       RETURNING id`,
      [ticketId, assetId],
    );
    return { ticketId, bookingId: b.rows[0].id };
  };

  const buildConsumer = (mail: FakeMail) => {
    const consumer = new NotificationsConsumer(
      outbox,
      config,
      mail as unknown as MailTransportService,
      { isEnabled: async () => true } as unknown as ConstructorParameters<
        typeof NotificationsConsumer
      >[3],
    );
    new CascadeCancelMailRegistrar(consumer, db).onModuleInit();
    return consumer;
  };

  const enqueue = async (ticketId: string, bookingId: string) => {
    await db.transaction(async (tx) => {
      await outbox.enqueueWithin(tx, 'booking_cancelled', {
        ticketId,
        bookingId,
      });
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
    await pool.query('DELETE FROM booking');
    await pool.query('DELETE FROM ticket');
    await pool.query('DELETE FROM assets');
    await pool.query('DELETE FROM users');
    await pool.query(
      `DELETE FROM config WHERE key = 'mail_consumer_baseline_at'`,
    );
    config.clearCache();
  });

  it('máy khóa sửa → mail người mượn: code + khung giờ + lý do "khóa" (AC1)', async () => {
    await insertUser('b1', 'b1@x.vn');
    const asset = await insertAsset('MAY-L1', 'locked_repair', true);
    const { ticketId, bookingId } = await insertCancelledBooking('b1', asset);
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    const evId = await enqueue(ticketId, bookingId);
    await consumer.handle('booking_cancelled', evId);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(['b1@x.vn']);
    expect(mail.sent[0].text).toContain('MAY-L1');
    expect(mail.sent[0].text).toContain('khóa');
    expect(mail.sent[0].text).toMatch(/\d{1,2}:\d{2}/); // có khung giờ (AC1)
  });

  it('máy thanh lý → lý do "thanh lý"', async () => {
    await insertUser('b1', 'b1@x.vn');
    const asset = await insertAsset('MAY-D1', 'disposed', true);
    const { ticketId, bookingId } = await insertCancelledBooking('b1', asset);
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    await consumer.handle(
      'booking_cancelled',
      await enqueue(ticketId, bookingId),
    );
    expect(mail.sent[0].text).toContain('thanh lý');
  });

  it('máy gỡ pool (in_use, is_pool=false) → lý do "gỡ"', async () => {
    await insertUser('b1', 'b1@x.vn');
    const asset = await insertAsset('MAY-P1', 'in_use', false);
    const { ticketId, bookingId } = await insertCancelledBooking('b1', asset);
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    await consumer.handle(
      'booking_cancelled',
      await enqueue(ticketId, bookingId),
    );
    expect(mail.sent[0].text).toContain('gỡ');
  });

  it('người mượn không email → không gửi, vẫn mark processed', async () => {
    await insertUser('b1', null);
    const asset = await insertAsset('MAY-N1', 'locked_repair', true);
    const { ticketId, bookingId } = await insertCancelledBooking('b1', asset);
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    const evId = await enqueue(ticketId, bookingId);
    await consumer.handle('booking_cancelled', evId);
    expect(mail.sent).toHaveLength(0);
    const ob = await pool.query<{ processed_at: string | null }>(
      `SELECT processed_at FROM outbox WHERE id=$1`,
      [evId],
    );
    expect(ob.rows[0].processed_at).not.toBeNull();
  });

  it('2 booking cùng người → 2 event → 2 mail (không gộp, AC2)', async () => {
    await insertUser('b1', 'b1@x.vn');
    const a1 = await insertAsset('MAY-A', 'locked_repair', true);
    const a2 = await insertAsset('MAY-B', 'locked_repair', true);
    const bk1 = await insertCancelledBooking('b1', a1);
    const bk2 = await insertCancelledBooking('b1', a2);
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    await consumer.handle(
      'booking_cancelled',
      await enqueue(bk1.ticketId, bk1.bookingId),
    );
    await consumer.handle(
      'booking_cancelled',
      await enqueue(bk2.ticketId, bk2.bookingId),
    );
    expect(mail.sent).toHaveLength(2);
    const codes = mail.sent.map((m) => m.text ?? '').join('|');
    expect(codes).toContain('MAY-A');
    expect(codes).toContain('MAY-B');
  });
});
