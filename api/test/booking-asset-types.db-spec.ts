import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 7.3 — lọc availability theo loại + endpoint asset-types (máy pool in_use). */
if (!process.env.DATABASE_URL) {
  throw new Error('[booking-asset-types.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[booking-asset-types.db-spec] Từ chối chạy '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const asMember = { 'x-dev-user-sub': 'mem-at', 'x-dev-role': 'member' };

describe('Availability lọc loại + asset-types (story 7.3)', () => {
  let app: INestApplication;
  let pool: Pool;

  const avail = (type?: string) =>
    request(app.getHttpServer())
      .get('/api/booking/availability')
      .query({ from: iso(1 * H), to: iso(2 * H), ...(type ? { type } : {}) })
      .set(asMember);

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-at','at@t.vn','Mem At','member')`,
    );
    // 2 laptop pool in_use, 1 desktop pool in_use, 1 printer NON-pool, 1 monitor locked
    await pool.query(
      `INSERT INTO assets (code, type, is_pool, status) VALUES
         ('AT-LAP1','laptop',true,'in_use'),
         ('AT-LAP2','laptop',true,'in_use'),
         ('AT-DESK','desktop',true,'in_use'),
         ('AT-PRINT','printer',false,'in_use'),
         ('AT-MON','monitor',true,'locked_repair')`,
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('AC1 — type=laptop chỉ trả máy laptop pool rảnh', async () => {
    const res = await avail('laptop').expect(200);
    const codes = (res.body as { code: string }[]).map((m) => m.code).sort();
    expect(codes).toEqual(['AT-LAP1', 'AT-LAP2']);
  });

  it('AC1 — type=desktop chỉ trả desktop', async () => {
    const res = await avail('desktop').expect(200);
    const codes = (res.body as { code: string }[]).map((m) => m.code);
    expect(codes).toEqual(['AT-DESK']);
  });

  it('AC3 — không type → tất cả máy pool in_use rảnh (regression)', async () => {
    const res = await avail().expect(200);
    const codes = (res.body as { code: string }[]).map((m) => m.code).sort();
    expect(codes).toEqual(['AT-DESK', 'AT-LAP1', 'AT-LAP2']);
  });

  it('AC2 — asset-types trả distinct loại máy pool in_use (không printer non-pool, không monitor locked)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/booking/asset-types')
      .set(asMember)
      .expect(200);
    expect(res.body).toEqual(['desktop', 'laptop']);
  });
});
