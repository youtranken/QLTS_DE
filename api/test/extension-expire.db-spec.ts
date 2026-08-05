import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { ExtensionService } from '../src/modules/tickets/extension.service';
import { createTestApp } from './test-app.helper';

/** Story 4.3 — sweep tự vô hiệu gia hạn khi hạn trả cũ trôi qua (AD-9, FR-47/49). */
if (!process.env.DATABASE_URL) {
  throw new Error('[extension-expire.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[extension-expire.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const H = 60 * 60 * 1000;
const D = 24 * H;

describe('Sweep vô hiệu gia hạn (story 4.3)', () => {
  let app: INestApplication;
  let pool: Pool;
  let ext: ExtensionService;

  const newMachine = async (code: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ($1,'laptop',true,'in_use') RETURNING id`,
      [code],
    );
    return r.rows[0].id;
  };

  const setup = async (
    assetId: string,
    from: string,
    oldDue: string,
    newDue: string,
  ) => {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('in_use','mem-x','mem-x') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','delivered', tstzrange($3,$4,'[)'))`,
      [t.rows[0].id, assetId, from, oldDue],
    );
    const e = await pool.query<{ id: string; version: number }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'extension','held', tstzrange($3,$4,'[)')) RETURNING id, version`,
      [t.rows[0].id, assetId, oldDue, newDue],
    );
    return { extId: e.rows[0].id, extVersion: e.rows[0].version };
  };

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-x','x@t.vn','Member X','member')`,
    );
    app = await createTestApp();
    ext = app.get(ExtensionService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('AC1: extension held hạn cũ đã qua → cancelled+result=expired (audit system), idempotent', async () => {
    const m = await newMachine('EXP-1');
    const s = await setup(m, iso(-2 * D), iso(-1 * H), iso(1 * D)); // old_due đã qua
    const n = await ext.expireStaleExtensions();
    expect(n).toBe(1);
    const ex = await pool.query<{ state: string; result: string }>(
      `SELECT state, result FROM booking WHERE id=$1`,
      [s.extId],
    );
    expect(ex.rows[0].state).toBe('cancelled');
    expect(ex.rows[0].result).toBe('expired');
    const au = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action='tickets.extension_expire' AND actor='system'`,
    );
    expect(au.rows[0].n).toBe(1);
    // idempotent: lần 2 không đụng gì
    expect(await ext.expireStaleExtensions()).toBe(0);
  });

  it('AC1: extension held hạn cũ CÒN tương lai → KHÔNG đụng', async () => {
    const m = await newMachine('EXP-2');
    const s = await setup(m, iso(-1 * H), iso(20 * H), iso(20 * H + 1 * D));
    await ext.expireStaleExtensions();
    const ex = await pool.query<{ state: string }>(
      `SELECT state FROM booking WHERE id=$1`,
      [s.extId],
    );
    expect(ex.rows[0].state).toBe('held'); // còn hiệu lực
  });

  it('AC2: sau khi vô hiệu, Admin bấm Duyệt (cache cũ) → 409 STALE_VERSION', async () => {
    const m = await newMachine('EXP-3');
    const s = await setup(m, iso(-2 * D), iso(-1 * H), iso(1 * D));
    await ext.expireStaleExtensions(); // version bump
    const res = await request(app.getHttpServer())
      .post(`/api/admin/tickets/extensions/${s.extId}/approve`)
      .set({ 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' })
      .send({ version: s.extVersion }) // version CŨ trước khi vô hiệu
      .expect(409);
    expect((res.body as { code: string }).code).toBe('STALE_VERSION');
  });
});
