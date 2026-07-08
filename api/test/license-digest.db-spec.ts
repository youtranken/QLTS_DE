import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import { OutboxService } from '../src/modules/outbox/outbox.service';
import { SystemConfigService } from '../src/modules/config/system-config.service';
import { LicenseDigestService } from '../src/modules/assets/license-digest.service';
import { NotificationsConsumer } from '../src/modules/notifications/notifications.consumer';
import { NotificationRecipientsService } from '../src/modules/notifications/notification-recipients.service';
import { LicenseDigestMailRegistrar } from '../src/modules/notifications/license-digest-mail.registrar';
import type {
  MailMessage,
  MailTransportService,
} from '../src/modules/notifications/mail-transport.service';

/** Story 5.6 — digest license sắp hết hạn. Chỉ cần Postgres. */
if (!process.env.DATABASE_URL) {
  throw new Error('[license-digest.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[license-digest.db-spec] Từ chối chạy trên '${dbName}'.`);
}

class FakeMail {
  sent: MailMessage[] = [];
  send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
}

// SweepService thật không cần — gọi emitLicenseDigest trực tiếp; onModuleInit không chạy.
const fakeSweep = { register: () => undefined } as never;

describe('License digest (story 5.6)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let outbox: OutboxService;
  let config: SystemConfigService;
  let digest: LicenseDigestService;
  let recipients: NotificationRecipientsService;

  const insertHost = async (code: string, status = 'in_use') => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, status, is_pool) VALUES ($1,'laptop',$2,true) RETURNING id`,
      [code, status],
    );
    return r.rows[0].id;
  };

  /** License software 'term'. endOffsetDays: hạn = hôm nay + n ngày. host=null → chưa gắn máy. */
  const insertLicense = async (
    code: string,
    name: string,
    endOffsetDays: number,
    host: string | null,
    licenseType = 'term',
  ) => {
    await pool.query(
      `INSERT INTO assets (code, type, status, is_pool, license_type, license_name, end_date, installed_on_asset_id)
       VALUES ($1,'software','in_use',false,$2,$3,
         CASE WHEN $2='term' THEN ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + $4::int) ELSE NULL END,
         $5)`,
      [code, licenseType, name, endOffsetDays, host],
    );
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
    digest = new LicenseDigestService(db, config, outbox, fakeSweep);
    recipients = new NotificationRecipientsService(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM outbox');
    await pool.query('DELETE FROM assets');
    await pool.query('DELETE FROM users');
    await pool.query(
      `DELETE FROM config WHERE key IN ('license_digest_sent_date', 'mail_consumer_baseline_at')`,
    );
    config.clearCache();
  });

  it('license term ≤30 ngày gắn máy → phát digest + set marker (AC1)', async () => {
    const host = await insertHost('HOST-1');
    await insertLicense('LIC-1', 'Office', 10, host);
    expect(await digest.emitLicenseDigest()).toBe(true);
    const ob = await pool.query(
      `SELECT 1 FROM outbox WHERE topic='license_digest'`,
    );
    expect(ob.rowCount).toBe(1);
    const mk = await pool.query<{ v: string }>(
      `SELECT value #>> '{}' AS v FROM config WHERE key='license_digest_sent_date'`,
    );
    expect(mk.rows[0].v).toBe(
      new Date().toLocaleDateString('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
      }),
    );
  });

  it('sweep lại cùng ngày → không phát; ngày VN mới → phát lại (AC1)', async () => {
    const host = await insertHost('HOST-1');
    await insertLicense('LIC-1', 'Office', 10, host);
    expect(await digest.emitLicenseDigest()).toBe(true);
    expect(await digest.emitLicenseDigest()).toBe(false);
    await pool.query(
      `UPDATE config SET value = to_jsonb((now() - interval '1 day')::date::text) WHERE key='license_digest_sent_date'`,
    );
    expect(await digest.emitLicenseDigest()).toBe(true);
  });

  it('perpetual / chưa gắn máy / host disposed / hạn xa → KHÔNG vào digest (AC3)', async () => {
    const host = await insertHost('HOST-OK');
    const disposedHost = await insertHost('HOST-DISP', 'disposed');
    await insertLicense('LIC-PERP', 'Perp', 0, host, 'perpetual'); // perpetual
    await insertLicense('LIC-NOHOST', 'NoHost', 10, null); // chưa gắn máy
    await insertLicense('LIC-DISP', 'OnDisposed', 10, disposedHost); // host thanh lý
    await insertLicense('LIC-FAR', 'Far', 100, host); // hạn xa
    expect(await digest.emitLicenseDigest()).toBe(false);
  });

  it('handler → 1 mail gộp liệt kê đúng license (AC1)', async () => {
    await pool.query(
      `INSERT INTO users (sub, email, role, status) VALUES ('admin1','admin@x.vn','admin','active')`,
    );
    const host = await insertHost('HOST-1');
    await insertLicense('LIC-A', 'Office', 5, host);
    await insertLicense('LIC-B', 'Adobe', 20, host);
    const mail = new FakeMail();
    const consumer = new NotificationsConsumer(
      outbox,
      config,
      mail as unknown as MailTransportService,
    );
    new LicenseDigestMailRegistrar(
      consumer,
      recipients,
      config,
      db,
    ).onModuleInit();
    await consumer.ensureBaseline();
    await db.transaction(async (tx) => {
      await outbox.enqueueWithin(tx, 'license_digest', {});
    });
    const ev = await pool.query<{ id: string }>(
      `SELECT id FROM outbox WHERE topic='license_digest' ORDER BY created_at DESC LIMIT 1`,
    );
    await consumer.handle('license_digest', ev.rows[0].id);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(['admin@x.vn']);
    expect(mail.sent[0].text).toContain('Office');
    expect(mail.sent[0].text).toContain('Adobe');
    expect(mail.sent[0].subject).toContain('2');
  });

  it('gia hạn (hạn xa) trước khi handler chạy → danh sách rỗng → KHÔNG mail (AC2)', async () => {
    await pool.query(
      `INSERT INTO users (sub, email, role, status) VALUES ('admin1','admin@x.vn','admin','active')`,
    );
    const host = await insertHost('HOST-1');
    await insertLicense('LIC-A', 'Office', 5, host);
    const mail = new FakeMail();
    const consumer = new NotificationsConsumer(
      outbox,
      config,
      mail as unknown as MailTransportService,
    );
    new LicenseDigestMailRegistrar(
      consumer,
      recipients,
      config,
      db,
    ).onModuleInit();
    await consumer.ensureBaseline();
    await db.transaction(async (tx) => {
      await outbox.enqueueWithin(tx, 'license_digest', {});
    });
    // Admin gia hạn LIC-A ra xa mốc → rời digest
    await pool.query(
      `UPDATE assets SET end_date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 200 WHERE code='LIC-A'`,
    );
    const ev = await pool.query<{ id: string }>(
      `SELECT id FROM outbox WHERE topic='license_digest' ORDER BY created_at DESC LIMIT 1`,
    );
    await consumer.handle('license_digest', ev.rows[0].id);
    expect(mail.sent).toHaveLength(0);
  });
});
