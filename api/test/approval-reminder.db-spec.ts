import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import { SystemConfigService } from '../src/modules/config/system-config.service';
import { OutboxService } from '../src/modules/outbox/outbox.service';
import { ApprovalReminderService } from '../src/modules/tickets/approval-reminder.service';
import { NotificationsConsumer } from '../src/modules/notifications/notifications.consumer';
import { NotificationRecipientsService } from '../src/modules/notifications/notification-recipients.service';
import { ApprovalMailRegistrar } from '../src/modules/notifications/approval-mail.registrar';
import type {
  MailMessage,
  MailTransportService,
} from '../src/modules/notifications/mail-transport.service';

/** Story 5.2 — sweep nhắc duyệt + handler mail. Chỉ cần Postgres. */
if (!process.env.DATABASE_URL) {
  throw new Error('[approval-reminder.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[approval-reminder.db-spec] Từ chối chạy trên '${dbName}'.`);
}

class FakeMail {
  sent: MailMessage[] = [];
  send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
}

describe('Approval reminder + mail (story 5.2)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let config: SystemConfigService;
  let outbox: OutboxService;
  let reminder: ApprovalReminderService;
  let recipients: NotificationRecipientsService;

  const insertUser = (sub: string, role: string, email: string | null) =>
    pool.query(
      `INSERT INTO users (sub, email, role, status) VALUES ($1, $2, $3, 'active')`,
      [sub, email, role],
    );

  /** Tạo ticket pending_approval, created_at lùi `daysAgo` ngày. Trả id. */
  const insertPendingTicket = async (borrower: string, daysAgo: number) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub, created_at)
       VALUES ('normal', 'pending_approval', $1, $1, now() - ($2 || ' days')::interval)
       RETURNING id`,
      [borrower, daysAgo],
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
    config = new SystemConfigService(db);
    outbox = new OutboxService(db);
    reminder = new ApprovalReminderService(db, config, outbox);
    recipients = new NotificationRecipientsService(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM outbox');
    await pool.query('DELETE FROM ticket');
    await pool.query('DELETE FROM users');
    await pool.query(
      `DELETE FROM config WHERE key = 'mail_consumer_baseline_at'`,
    );
    config.clearCache();
  });

  it('request treo đủ giờ làm việc → phát approval_reminder + set marker ngày (AC2)', async () => {
    await insertUser('borrower1', 'member', 'b1@x.vn');
    const id = await insertPendingTicket('borrower1', 10); // treo 10 ngày → thừa 4h làm việc
    const n = await reminder.emitApprovalReminders();
    expect(n).toBe(1);
    const ob = await pool.query(
      `SELECT topic, payload FROM outbox WHERE topic = 'approval_reminder'`,
    );
    expect(ob.rowCount).toBe(1);
    expect(ob.rows[0].payload).toEqual({ ticketId: id });
    const mk = await pool.query<{ d: string | null }>(
      `SELECT approval_reminder_date::text AS d FROM ticket WHERE id = $1`,
      [id],
    );
    expect(mk.rows[0].d).not.toBeNull();
  });

  it('sweep chạy lại CÙNG ngày → không phát lại (idempotent theo ngày)', async () => {
    await insertUser('borrower1', 'member', 'b1@x.vn');
    await insertPendingTicket('borrower1', 10);
    expect(await reminder.emitApprovalReminders()).toBe(1);
    expect(await reminder.emitApprovalReminders()).toBe(0);
    const ob = await pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE topic = 'approval_reminder'`,
    );
    expect(ob.rows[0].n).toBe(1);
  });

  it('sang NGÀY VN mới (marker < today) → phát lại', async () => {
    await insertUser('borrower1', 'member', 'b1@x.vn');
    const id = await insertPendingTicket('borrower1', 10);
    await reminder.emitApprovalReminders();
    // giả lập đã nhắc HÔM QUA
    await pool.query(
      `UPDATE ticket SET approval_reminder_date = (now() - interval '1 day')::date WHERE id = $1`,
      [id],
    );
    await pool.query(`DELETE FROM outbox`);
    expect(await reminder.emitApprovalReminders()).toBe(1);
  });

  it('request chưa đủ giờ làm việc → không phát', async () => {
    await insertUser('borrower1', 'member', 'b1@x.vn');
    await insertPendingTicket('borrower1', 0); // vừa tạo → ~0 phút làm việc
    expect(await reminder.emitApprovalReminders()).toBe(0);
  });

  it('ticket đã rời pending (closed) → không phải candidate', async () => {
    await insertUser('borrower1', 'member', 'b1@x.vn');
    await pool.query(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub, created_at)
       VALUES ('normal', 'closed', 'borrower1', 'borrower1', now() - interval '10 days')`,
    );
    expect(await reminder.emitApprovalReminders()).toBe(0);
  });

  it('adminEmails chỉ lấy role=admin active có email', async () => {
    await insertUser('a1', 'admin', 'admin1@x.vn');
    await insertUser('a2', 'admin', null); // không email → loại
    await insertUser('m1', 'member', 'member@x.vn'); // member → loại
    await pool.query(
      `INSERT INTO users (sub, email, role, status) VALUES ('a3', 'a3@x.vn', 'admin', 'disabled')`,
    ); // disabled → loại
    const emails = await recipients.adminEmails();
    expect(emails).toEqual(['admin1@x.vn']);
  });

  // ---- handler mail qua consumer ----
  const buildConsumer = (mail: FakeMail) => {
    const consumer = new NotificationsConsumer(
      outbox,
      config,
      mail as unknown as MailTransportService,
    );
    const registrar = new ApprovalMailRegistrar(consumer, recipients, db);
    registrar.onModuleInit();
    return consumer;
  };

  const enqueue = async (topic: string, ticketId: string) => {
    await db.transaction(async (tx) => {
      await outbox.enqueueWithin(tx, topic, { ticketId });
    });
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM outbox ORDER BY created_at DESC LIMIT 1`,
    );
    return r.rows[0].id;
  };

  it('approval_requested → gửi tới nhóm Admin, kèm link (AC1)', async () => {
    await insertUser('admin1', 'admin', 'admin1@x.vn');
    await insertUser('borrower1', 'member', 'b1@x.vn');
    const ticketId = await insertPendingTicket('borrower1', 0);
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    const evId = await enqueue('approval_requested', ticketId);
    await consumer.handle('approval_requested', evId);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(['admin1@x.vn']);
    expect(mail.sent[0].text).toContain('/xu-ly-muon');
  });

  it('ticket đã duyệt (rời pending) → handler KHÔNG gửi mail lỗi thời (AC3)', async () => {
    await insertUser('admin1', 'admin', 'admin1@x.vn');
    await insertUser('borrower1', 'member', 'b1@x.vn');
    const r = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub)
       VALUES ('normal', 'awaiting_pickup', 'borrower1', 'borrower1') RETURNING id`,
    );
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    const evId = await enqueue('approval_reminder', r.rows[0].id);
    await consumer.handle('approval_reminder', evId);
    expect(mail.sent).toHaveLength(0);
    // vẫn mark processed → không kẹt queue
    const ob = await pool.query<{ processed_at: string | null }>(
      `SELECT processed_at FROM outbox WHERE id = $1`,
      [evId],
    );
    expect(ob.rows[0].processed_at).not.toBeNull();
  });

  it('không có admin email → bỏ qua gửi, không crash', async () => {
    await insertUser('borrower1', 'member', 'b1@x.vn');
    const ticketId = await insertPendingTicket('borrower1', 0);
    const mail = new FakeMail();
    const consumer = buildConsumer(mail);
    await consumer.ensureBaseline();
    const evId = await enqueue('approval_requested', ticketId);
    await consumer.handle('approval_requested', evId);
    expect(mail.sent).toHaveLength(0);
  });
});
