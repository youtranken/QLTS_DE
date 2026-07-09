import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 8.3 — Pool máy cho mượn: thêm máy vào pool bằng MTS + read danh sách. */
if (!process.env.DATABASE_URL) {
  throw new Error('[pool.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[pool.db-spec] Từ chối chạy '${dbName}'.`);
}

const asSa = { 'x-dev-user-sub': 'sa-pool', 'x-dev-role': 'sa' };
const asMember = { 'x-dev-user-sub': 'mem-pool', 'x-dev-role': 'member' };

describe('Pool máy cho mượn (story 8.3)', () => {
  let app: INestApplication;
  let pool: Pool;

  const getPool = (headers = asSa) =>
    request(app.getHttpServer()).get('/api/admin/pool').set(headers);
  const addPool = (code: string, headers = asSa) =>
    request(app.getHttpServer())
      .post('/api/admin/pool')
      .set(headers)
      .send({ code });

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS catalog, department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO assets (code, type, status) VALUES
        ('PC-1','Laptop','in_use'),
        ('OLD-1','Laptop','disposed'),
        ('LOCK-1','Laptop','locked_repair')`,
    );
    await pool.query(
      `INSERT INTO assets (code, type, status, license_type, license_name)
        VALUES ('SW-1','software','in_use','perpetual','WinX')`,
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('member → 403 (GET + POST)', async () => {
    await getPool(asMember).expect(403);
    await addPool('PC-1', asMember).expect(403);
  });

  it('GET pool ban đầu rỗng', async () => {
    const res = await getPool().expect(200);
    expect(res.body).toEqual([]);
  });

  it('Thêm máy in_use bằng MTS → 201 + hiện trong pool', async () => {
    const res = await addPool('PC-1').expect(201);
    expect(res.body.code).toBe('PC-1');
    const list = await getPool().expect(200);
    expect((list.body as Array<{ code: string }>).map((x) => x.code)).toEqual([
      'PC-1',
    ]);
    const db = await pool.query("SELECT is_pool FROM assets WHERE code='PC-1'");
    expect(db.rows[0].is_pool).toBe(true);
  });

  it('Thêm lại (case-insensitive) máy đã trong pool → idempotent ok', async () => {
    await addPool('pc-1').expect(201);
    const list = await getPool().expect(200);
    expect(list.body).toHaveLength(1); // không nhân đôi
  });

  it('Software → 400 (không cho mượn như máy)', async () => {
    await addPool('SW-1').expect(400);
  });

  it('Máy thanh lý / khóa sửa (không in_use) → 400', async () => {
    await addPool('OLD-1').expect(400);
    await addPool('LOCK-1').expect(400);
  });

  it('Mã không tồn tại → 404', async () => {
    await addPool('KHONG-CO').expect(404);
  });
});
