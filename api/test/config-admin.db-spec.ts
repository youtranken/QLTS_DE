import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';
import { SystemConfigService } from '../src/modules/config/system-config.service';
import { ConfigAdminService } from '../src/modules/config/config-admin.service';
import type { AuditWriterService } from '../src/modules/audit/audit-writer.service';

/** Story 6.3 — màn cấu hình tham số SA (7 tham số FR-44 + hiệu lực ngay). */
if (!process.env.DATABASE_URL) {
  throw new Error('[config-admin.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[config-admin.db-spec] Từ chối chạy '${dbName}'.`);
}

const asSa = { 'x-dev-user-sub': 'sa-cf', 'x-dev-role': 'sa' };
const asAdmin = { 'x-dev-user-sub': 'adm-cf', 'x-dev-role': 'admin' };

describe('Config admin (story 6.3)', () => {
  let app: INestApplication;
  let pool: Pool;

  const getCfg = (headers = asSa) =>
    request(app.getHttpServer()).get('/api/admin/config').set(headers);
  const putCfg = (body: Record<string, unknown>, headers = asSa) =>
    request(app.getHttpServer())
      .put('/api/admin/config')
      .set(headers)
      .send(body);

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('AC1 — SA GET trả đúng 7 tham số FR-44, KHÔNG marker runtime', async () => {
    // 5.5 seed 'directory_sync_interval_minutes' — marker KHÔNG được lộ ra màn config
    const res = await getCfg().expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'active_ticket_quota',
      'approval_reminder_working_hours',
      'booking_window_days',
      'extension_days_per_grant',
      'extension_max_grants',
      'license_warning_days',
      'working_hours',
    ]);
    expect(res.body).not.toHaveProperty('directory_sync_interval_minutes');
    expect(res.body).not.toHaveProperty('mail_consumer_baseline_at');
  });

  it('AC1 — Admin → 403 (GET + PUT)', async () => {
    await getCfg(asAdmin).expect(403);
    await putCfg({ booking_window_days: 45 }, asAdmin).expect(403);
  });

  it('AC2 — PUT hợp lệ đổi giá trị + audit config.update from→to', async () => {
    const res = await putCfg({ booking_window_days: 45 }).expect(200);
    expect(res.body.booking_window_days).toBe(45);
    const audit = await pool.query(
      "SELECT actor, object_id, detail FROM audit_log WHERE action='config.update' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.rows[0].actor).toBe('sa-cf');
    expect(audit.rows[0].object_id).toBe('booking_window_days');
    expect(audit.rows[0].detail).toMatchObject({ from: 30, to: 45 });
  });

  it('AC2 — biên sai → 400: quota<1, end≤start, days rỗng, không key hợp lệ', async () => {
    await putCfg({ active_ticket_quota: 0 }).expect(400); // DTO Min(1)
    await putCfg({
      working_hours: {
        tz: 'Asia/Ho_Chi_Minh',
        days: [1, 2],
        start: '17:00',
        end: '08:00',
      },
    }).expect(400); // end ≤ start
    await putCfg({
      working_hours: {
        tz: 'Asia/Ho_Chi_Minh',
        days: [],
        start: '08:00',
        end: '17:00',
      },
    }).expect(400); // days rỗng
    await putCfg({ unknown_key: 5 }).expect(400); // whitelist strip → không key hợp lệ
  });

  it('AC2 — clearCache: getter đọc giá trị mới NGAY (không chờ TTL)', async () => {
    const db = drizzle(pool);
    const auditStub = {
      appendWithin: () => Promise.resolve(),
      append: () => Promise.resolve(),
    } as unknown as AuditWriterService;
    const sysCfg = new SystemConfigService(db);
    const cfgAdmin = new ConfigAdminService(db, auditStub, sysCfg);
    // prime cache
    await pool.query(
      "UPDATE config SET value='2' WHERE key='active_ticket_quota'",
    );
    expect(await sysCfg.getActiveTicketQuota()).toBe(2);
    // update qua service → clearCache → getter thấy 5 ngay
    await cfgAdmin.update({ active_ticket_quota: 5 }, 'sa-cf');
    expect(await sysCfg.getActiveTicketQuota()).toBe(5);
  });
});
