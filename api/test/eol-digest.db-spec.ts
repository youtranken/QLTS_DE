import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import { OutboxService } from '../src/modules/outbox/outbox.service';
import { SystemConfigService } from '../src/modules/config/system-config.service';
import { EolDigestService } from '../src/modules/assets/eol-digest.service';
import { NotificationsConsumer } from '../src/modules/notifications/notifications.consumer';
import { NotificationRecipientsService } from '../src/modules/notifications/notification-recipients.service';
import { EolDigestMailRegistrar } from '../src/modules/notifications/eol-digest-mail.registrar';
import type {
  MailMessage,
  MailTransportService,
} from '../src/modules/notifications/mail-transport.service';

/** Digest EOL — chỉ báo MÁY MỚI đủ tuổi thọ, không nhắc lại máy đã báo. Chỉ cần Postgres. */
if (!process.env.DATABASE_URL) {
  throw new Error('[eol-digest.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[eol-digest.db-spec] Từ chối chạy trên '${dbName}'.`);
}

class FakeMail {
  sent: MailMessage[] = [];
  send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
    return Promise.resolve();
  }
}

const fakeSweep = { register: () => undefined } as never;
const mailSettings = {
  getDigestTime: async () => '00:00',
  isEnabled: async () => true,
} as unknown as ConstructorParameters<typeof EolDigestService>[4];

describe('EOL digest — chỉ báo máy MỚI', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let outbox: OutboxService;
  let config: SystemConfigService;
  let digest: EolDigestService;
  let recipients: NotificationRecipientsService;

  /** Máy PC start_date = hôm nay VN − ageYears năm. Mặc định 9 năm (> lifespan 8) → đủ tuổi. */
  const insertMachine = async (code: string, ageYears = 9, status = 'in_use') => {
    await pool.query(
      `INSERT INTO assets (code, type, status, is_pool, start_date)
       VALUES ($1,'pc',$2,true,
         ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - make_interval(years => $3::int))::date)`,
      [code, status, ageYears],
    );
  };

  const runHandler = async (): Promise<FakeMail> => {
    const mail = new FakeMail();
    const consumer = new NotificationsConsumer(
      outbox,
      config,
      mail as unknown as MailTransportService,
      { isEnabled: async () => true } as unknown as ConstructorParameters<
        typeof NotificationsConsumer
      >[3],
    );
    new EolDigestMailRegistrar(consumer, recipients, config, db).onModuleInit();
    await consumer.ensureBaseline();
    const ev = await pool.query<{ id: string }>(
      `SELECT id FROM outbox WHERE topic='eol_digest' ORDER BY created_at DESC LIMIT 1`,
    );
    await consumer.handle('eol_digest', ev.rows[0].id);
    return mail;
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
    digest = new EolDigestService(db, config, outbox, fakeSweep, mailSettings);
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
      `INSERT INTO users (sub, email, role, status) VALUES ('admin1','admin@x.vn','admin','active')`,
    );
    await pool.query(
      `DELETE FROM config WHERE key IN ('eol_digest_sent_week', 'mail_consumer_baseline_at')`,
    );
    config.clearCache();
    // Stamp baseline TRƯỚC khi emit → event (created_at sau) không bị coi là tồn đọng và bị skip.
    await config.ensureMailConsumerBaseline();
  });

  it('máy đủ tuổi chưa báo → phát digest + set marker tuần', async () => {
    await insertMachine('PC-1');
    await insertMachine('PC-2');
    expect(await digest.emitEolDigest()).toBe(true);
    const ob = await pool.query(`SELECT 1 FROM outbox WHERE topic='eol_digest'`);
    expect(ob.rowCount).toBe(1);
  });

  it('máy chưa đủ tuổi / disposed → KHÔNG phát', async () => {
    await insertMachine('PC-NEW', 3); // mới 3 năm
    await insertMachine('PC-DISP', 9, 'disposed'); // đủ tuổi nhưng đã thanh lý
    expect(await digest.emitEolDigest()).toBe(false);
  });

  it('handler → 1 mail liệt kê đúng máy + đánh dấu eol_notified_at', async () => {
    await insertMachine('PC-A');
    await insertMachine('PC-B');
    expect(await digest.emitEolDigest()).toBe(true);
    const mail = await runHandler();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(['admin@x.vn']);
    expect(mail.sent[0].text).toContain('PC-A');
    expect(mail.sent[0].text).toContain('PC-B');
    expect(mail.sent[0].subject).toContain('mới');
    const marked = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM assets WHERE eol_notified_at IS NOT NULL`,
    );
    expect(marked.rows[0].n).toBe(2);
  });

  it('lần 2 cùng danh sách đã báo → KHÔNG phát; thêm máy MỚI → phát lại chỉ máy mới', async () => {
    await insertMachine('PC-A');
    await insertMachine('PC-B');
    // Lần 1: báo cả 2, đánh dấu.
    expect(await digest.emitEolDigest()).toBe(true);
    await runHandler();
    // Sang tuần mới (không còn bị chặn bởi marker tuần) nhưng 2 máy cũ đã báo → không phát.
    await pool.query(`DELETE FROM config WHERE key='eol_digest_sent_week'`);
    expect(await digest.emitEolDigest()).toBe(false);
    // Thêm 1 máy mới đủ tuổi → phát lại, mail chỉ chứa máy mới.
    await insertMachine('PC-C');
    expect(await digest.emitEolDigest()).toBe(true);
    const mail = await runHandler();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].text).toContain('PC-C');
    expect(mail.sent[0].text).not.toContain('PC-A');
    expect(mail.sent[0].text).not.toContain('PC-B');
    expect(mail.sent[0].subject).toContain('1');
  });

  it('lần 2 cùng tuần (sweep đúp) → KHÔNG phát lại', async () => {
    await insertMachine('PC-A');
    expect(await digest.emitEolDigest()).toBe(true);
    expect(await digest.emitEolDigest()).toBe(false);
  });
});
