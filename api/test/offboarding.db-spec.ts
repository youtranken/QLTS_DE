import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import { OutboxService } from '../src/modules/outbox/outbox.service';
import { SystemConfigService } from '../src/modules/config/system-config.service';
import { AuditWriterService } from '../src/modules/audit/audit-writer.service';
import { OffboardingService } from '../src/modules/tickets/offboarding.service';
import { NotificationsConsumer } from '../src/modules/notifications/notifications.consumer';
import { NotificationRecipientsService } from '../src/modules/notifications/notification-recipients.service';
import { OffboardMailRegistrar } from '../src/modules/notifications/offboard-mail.registrar';
import type {
  MailMessage,
  MailTransportService,
} from '../src/modules/notifications/mail-transport.service';

/** Story 5.5 — offboarding scan + cascade + queue + mail. Chỉ cần Postgres. */
if (!process.env.DATABASE_URL) {
  throw new Error('[offboarding.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[offboarding.db-spec] Từ chối chạy trên '${dbName}'.`);
}

class FakeMail {
  sent: MailMessage[] = [];
  send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
}

describe('Offboarding scan + cascade (story 5.5)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let outbox: OutboxService;
  let config: SystemConfigService;
  let audit: AuditWriterService;
  let offboarding: OffboardingService;
  let recipients: NotificationRecipientsService;

  const insertUser = (
    sub: string,
    status: string,
    role = 'member',
    email: string | null = null,
    fullName: string | null = null,
  ) =>
    pool.query(
      `INSERT INTO users (sub, email, full_name, role, status) VALUES ($1,$2,$3,$4,$5)`,
      [sub, email, fullName, role, status],
    );

  const insertAsset = async (
    code: string,
    owner: string | null = null,
    needsMatch = false,
    importedText: string | null = null,
  ) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, status, is_pool, assigned_user_sub, needs_user_match, imported_user_text)
       VALUES ($1,'laptop','in_use',true,$2,$3,$4) RETURNING id`,
      [code, owner, needsMatch, importedText],
    );
    return r.rows[0].id;
  };

  const insertTicket = async (state: string, borrower: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub) VALUES ('normal',$1,$2,$2) RETURNING id`,
      [state, borrower],
    );
    return r.rows[0].id;
  };

  const insertBooking = (
    ticketId: string,
    assetId: string,
    state: string,
    fromH: number,
    toH: number,
  ) =>
    pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1,$2,'normal',$3, tstzrange(now() + ($4||' hours')::interval, now() + ($5||' hours')::interval, '[)'))`,
      [ticketId, assetId, state, fromH, toH],
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS processed_webhook_events, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    db = drizzle(pool);
    outbox = new OutboxService(db);
    config = new SystemConfigService(db);
    audit = new AuditWriterService(db);
    offboarding = new OffboardingService(db, outbox, audit);
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

  it('user locked còn ticket → cascade: hủy chờ-giao/held, GIỮ in_use, phát offboard_alert (AC3)', async () => {
    await insertUser('u1', 'locked');
    const a1 = await insertAsset('OFB-A');
    const a2 = await insertAsset('OFB-B');
    const pending = await insertTicket('pending_approval', 'u1');
    await insertBooking(pending, a1, 'held', 24, 48); // future held
    const inUse = await insertTicket('in_use', 'u1');
    await insertBooking(inUse, a2, 'delivered', -1, 48); // đang mượn

    const n = await offboarding.runOffboardingScan();
    expect(n).toBe(1);

    const pRow = await pool.query<{ state: string }>(
      `SELECT state FROM ticket WHERE id=$1`,
      [pending],
    );
    expect(pRow.rows[0].state).toBe('cancelled'); // chờ duyệt → cancelled
    const heldRow = await pool.query<{ state: string }>(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [pending],
    );
    expect(heldRow.rows[0].state).toBe('cancelled'); // nhả khung
    const iRow = await pool.query<{ state: string }>(
      `SELECT state FROM ticket WHERE id=$1`,
      [inUse],
    );
    expect(iRow.rows[0].state).toBe('in_use'); // GIỮ — Admin thu hồi tay (FR-4a)

    const ob = await pool.query(
      `SELECT payload FROM outbox WHERE topic='offboard_alert'`,
    );
    expect(ob.rowCount).toBe(1);
    expect(ob.rows[0].payload).toEqual({ sub: 'u1' });
    const mk = await pool.query<{ a: string | null }>(
      `SELECT offboard_alerted_at::text AS a FROM users WHERE sub='u1'`,
    );
    expect(mk.rows[0].a).not.toBeNull();
  });

  it('scan chạy lại → không cảnh báo đúp (marker); active lại → reset marker (AC4)', async () => {
    await insertUser('u1', 'locked');
    await insertAsset('OFB-C', 'u1'); // đứng tên tài sản
    expect(await offboarding.runOffboardingScan()).toBe(1);
    expect(await offboarding.runOffboardingScan()).toBe(0);
    // mở khóa về active → reset marker + rời queue
    await pool.query(`UPDATE users SET status='active' WHERE sub='u1'`);
    await offboarding.runOffboardingScan();
    const mk = await pool.query<{ a: string | null }>(
      `SELECT offboard_alerted_at::text AS a FROM users WHERE sub='u1'`,
    );
    expect(mk.rows[0].a).toBeNull(); // tự tắt
    // disable lại → cảnh báo lại
    await pool.query(`UPDATE users SET status='locked' WHERE sub='u1'`);
    expect(await offboarding.runOffboardingScan()).toBe(1);
  });

  it('user chỉ có pending/awaiting (không in_use/tài sản) → hủy sạch, KHÔNG cảnh báo (M1)', async () => {
    await insertUser('u4', 'locked');
    const a = await insertAsset('OFB-P');
    const pending = await insertTicket('pending_approval', 'u4');
    await insertBooking(pending, a, 'held', 24, 48);
    // cascade hủy pending nhưng không còn gì để thu hồi → không mail/queue
    expect(await offboarding.runOffboardingScan()).toBe(0);
    const p = await pool.query<{ state: string }>(
      `SELECT state FROM ticket WHERE id=$1`,
      [pending],
    );
    expect(p.rows[0].state).toBe('cancelled'); // vẫn được dọn
    const ob = await pool.query(
      `SELECT 1 FROM outbox WHERE topic='offboard_alert'`,
    );
    expect(ob.rowCount).toBe(0);
    const q = await offboarding.listOffboardingQueue();
    expect(q.total).toBe(0);
  });

  it('user đứng tên tài sản (không ticket) vẫn cảnh báo (AC4/FR-4b)', async () => {
    await insertUser('u2', 'deleted');
    await insertAsset('OFB-D', 'u2');
    expect(await offboarding.runOffboardingScan()).toBe(1);
  });

  it('máy đã thanh lý/purge KHÔNG tính là đang giữ → hết phantom offboarding (audit H1)', async () => {
    await insertUser('u5', 'deleted');
    // chỉ đứng tên máy đã disposed → không còn gì để thu hồi
    const disposed = await insertAsset('OFB-DISP', 'u5');
    await pool.query(
      `UPDATE assets SET status='disposed', is_pool=false WHERE id=$1`,
      [disposed],
    );
    expect(await offboarding.runOffboardingScan()).toBe(0);
    expect((await offboarding.listOffboardingQueue()).total).toBe(0);

    // thêm máy purged cũng không tính
    const purged = await insertAsset('OFB-PURG', 'u5');
    await pool.query(
      `UPDATE assets SET status='disposed', is_pool=false, purged_at=now() WHERE id=$1`,
      [purged],
    );
    expect(await offboarding.runOffboardingScan()).toBe(0);

    // còn 1 máy đang dùng → cảnh báo trở lại (chốt: filter đúng, không chặn nhầm)
    await insertAsset('OFB-LIVE', 'u5');
    expect(await offboarding.runOffboardingScan()).toBe(1);
    const q = await offboarding.listOffboardingQueue();
    expect(q.total).toBe(1);
    expect(q.alerts[0].assetCount).toBe(1); // chỉ đếm máy đang dùng, bỏ disposed+purged
  });

  it('user active dù có ticket → KHÔNG cảnh báo', async () => {
    await insertUser('u3', 'active');
    const t = await insertTicket('in_use', 'u3');
    await insertBooking(t, await insertAsset('OFB-E'), 'delivered', -1, 48);
    expect(await offboarding.runOffboardingScan()).toBe(0);
  });

  it('queue: liệt kê user disable + đếm; mục cần đối chiếu RIÊNG (AC5)', async () => {
    await insertUser('u1', 'locked', 'member', null, 'Nguyen A');
    await insertAsset('OFB-F', 'u1');
    await insertAsset('OFB-IMP', null, true, 'Le Van Import'); // cần đối chiếu
    const q = await offboarding.listOffboardingQueue();
    expect(q.total).toBe(1);
    expect(q.alerts[0].sub).toBe('u1');
    expect(q.alerts[0].assetCount).toBe(1);
    expect(q.needsMatch).toHaveLength(1);
    expect(q.needsMatch[0].code).toBe('OFB-IMP');
  });

  it('offboard_alert handler → mail Admin nêu số ticket/tài sản (FR-28)', async () => {
    await insertUser('admin1', 'active', 'admin', 'admin@x.vn');
    await insertUser('u1', 'locked', 'member', null, 'Nguyen A');
    await insertAsset('OFB-G', 'u1');
    const t = await insertTicket('in_use', 'u1');
    await insertBooking(t, await insertAsset('OFB-H'), 'delivered', -1, 48);

    const mail = new FakeMail();
    const consumer = new NotificationsConsumer(
      outbox,
      config,
      mail as unknown as MailTransportService,
      { isEnabled: async () => true } as unknown as ConstructorParameters<
        typeof NotificationsConsumer
      >[3],
    );
    new OffboardMailRegistrar(consumer, recipients, db).onModuleInit();
    await consumer.ensureBaseline();
    await db.transaction(async (tx) => {
      await outbox.enqueueWithin(tx, 'offboard_alert', { sub: 'u1' });
    });
    const ev = await pool.query<{ id: string }>(
      `SELECT id FROM outbox WHERE topic='offboard_alert' ORDER BY created_at DESC LIMIT 1`,
    );
    await consumer.handle('offboard_alert', ev.rows[0].id);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(['admin@x.vn']);
    expect(mail.sent[0].text).toContain('Nguyen A');
    expect(mail.sent[0].text).toContain('offboarding');
  });
});
