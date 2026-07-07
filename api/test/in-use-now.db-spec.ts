import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 3.11 — "máy đang được mượn" read-model (NFR-2, AD-5 không lộ sub/email). */
if (!process.env.DATABASE_URL) {
  throw new Error('[in-use-now.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[in-use-now.db-spec] Từ chối chạy trên '${dbName}'.`);
}
const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const asMember = { 'x-dev-user-sub': 'mem-o', 'x-dev-role': 'member' };

describe('Máy đang được mượn (story 3.11)', () => {
  let app: INestApplication;
  let pool: Pool;

  const mk = async (code: string, ticketState: string, bkState: string) => {
    const a = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ($1,'laptop',true,'in_use') RETURNING id`,
      [code],
    );
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ($1,'mem-o','mem-o') RETURNING id`,
      [ticketState],
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal',$3, tstzrange($4,$5,'[)'))`,
      [t.rows[0].id, a.rows[0].id, bkState, iso(-1 * H), iso(3 * H)],
    );
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
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-o','secret@t.vn','Nguyen Van A','member')`,
    );
    await mk('IU-1', 'in_use', 'delivered'); // đang mượn → hiện
    await mk('IU-2', 'awaiting_pickup', 'pending'); // chờ giao → KHÔNG hiện
    await mk('IU-3', 'closed', 'returned'); // đã trả → KHÔNG hiện
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('member 200: chỉ máy in_use hiện, kèm tên + máy + khung (AC 1/2)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/booking/in-use-now')
      .set(asMember)
      .expect(200);
    const rows = res.body as Array<{ borrowerName: string; assetCode: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].assetCode).toBe('IU-1');
    expect(rows[0].borrowerName).toBe('Nguyen Van A');
  });

  it('AD-5: payload KHÔNG lộ sub/email (chỉ full_name)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/booking/in-use-now')
      .set(asMember)
      .expect(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/mem-o/); // sub
    expect(raw).not.toMatch(/@/); // email
    const keys = Object.keys(
      (res.body as Array<Record<string, unknown>>)[0],
    ).sort();
    expect(keys).toEqual(['assetCode', 'borrowerName', 'from', 'to']);
  });

  it('anonymous → 401', async () => {
    await request(app.getHttpServer())
      .get('/api/booking/in-use-now')
      .expect(401);
  });
});
