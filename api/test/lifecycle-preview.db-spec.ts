import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.13 — preview cascade (dry-run) + cờ notify khi Khóa/Gỡ pool/Thanh lý.
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[lifecycle-preview.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[lifecycle-preview.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const asAdmin = { 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' };

describe('Preview cascade + notify (story 3.13)', () => {
  let app: INestApplication;
  let pool: Pool;

  const newMachine = async (code: string) => {
    const r = await pool.query<{ id: string; version: number }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ($1,'laptop',true,'in_use') RETURNING id, version`,
      [code],
    );
    return r.rows[0];
  };

  const mkBooking = async (
    assetId: string,
    ticketState: string,
    bkState: string,
    from: string,
    to: string,
  ) => {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ($1,'mem-o','mem-o') RETURNING id`,
      [ticketState],
    );
    const b = await pool.query<{ id: string }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal',$3, tstzrange($4,$5,'[)')) RETURNING id`,
      [t.rows[0].id, assetId, bkState, from, to],
    );
    return { ticketId: t.rows[0].id, bookingId: b.rows[0].id };
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
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-o','o@t.vn','Owner','member')`,
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('AC1: preview trả futureCancellations + inUseRecalls, chỉ display name (không sub/email)', async () => {
    const m = await newMachine('PV-1');
    await mkBooking(
      m.id,
      'awaiting_pickup',
      'pending',
      iso(10 * H),
      iso(12 * H),
    );
    // delivered khung KHÔNG chồng pending (tránh EXCLUDE 23P01)
    await mkBooking(m.id, 'in_use', 'delivered', iso(-1 * H), iso(5 * H));
    const res = await request(app.getHttpServer())
      .get(`/api/admin/assets/${m.id}/lifecycle-preview`)
      .set(asAdmin)
      .expect(200);
    const body = res.body as {
      futureCancellations: Array<{ borrowerName: string }>;
      inUseRecalls: Array<{ borrowerName: string }>;
    };
    expect(body.futureCancellations).toHaveLength(1);
    expect(body.inUseRecalls).toHaveLength(1);
    expect(body.futureCancellations[0].borrowerName).toBe('Owner');
    expect(body.inUseRecalls[0].borrowerName).toBe('Owner');
    // AD-5: không lộ sub/email trong payload
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/@/);
    expect(raw).not.toContain('mem-o');
  });

  it('AC1: preview KHÔNG mutate (booking state + asset.version giữ nguyên)', async () => {
    const m = await newMachine('PV-2');
    const b = await mkBooking(
      m.id,
      'awaiting_pickup',
      'pending',
      iso(10 * H),
      iso(12 * H),
    );
    await request(app.getHttpServer())
      .get(`/api/admin/assets/${m.id}/lifecycle-preview`)
      .set(asAdmin)
      .expect(200);
    const bk = await pool.query(`SELECT state FROM booking WHERE id=$1`, [
      b.bookingId,
    ]);
    const a = await pool.query(
      `SELECT status, version FROM assets WHERE id=$1`,
      [m.id],
    );
    expect(bk.rows[0].state).toBe('pending'); // không hủy
    expect(a.rows[0].status).toBe('in_use'); // không đổi status
    expect(a.rows[0].version).toBe(m.version); // không bump version
  });

  it('AC3: notify=false → 0 outbox booking_cancelled NHƯNG audit cascade_cancel vẫn ghi', async () => {
    const m = await newMachine('PV-3');
    const b = await mkBooking(
      m.id,
      'awaiting_pickup',
      'pending',
      iso(10 * H),
      iso(12 * H),
    );
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${m.id}/lock`)
      .set(asAdmin)
      .send({ version: m.version, reason: 'sửa', notify: false })
      .expect(200);
    // booking vẫn bị hủy (cascade chạy)
    const bk = await pool.query(`SELECT state FROM booking WHERE id=$1`, [
      b.bookingId,
    ]);
    expect(bk.rows[0].state).toBe('cancelled');
    // KHÔNG mail
    const ob = await pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE topic='booking_cancelled' AND payload->>'bookingId'=$1`,
      [b.bookingId],
    );
    expect(ob.rows[0].n).toBe(0);
    // audit VẪN ghi
    const au = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action='tickets.cascade_cancel' AND object_id=$1`,
      [b.ticketId],
    );
    expect(au.rows[0].n).toBe(1);
  });

  it('AC3: notify=true (mặc định) → outbox booking_cancelled = số booking hủy', async () => {
    const m = await newMachine('PV-4');
    const b = await mkBooking(
      m.id,
      'awaiting_pickup',
      'pending',
      iso(10 * H),
      iso(12 * H),
    );
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${m.id}/lock`)
      .set(asAdmin)
      .send({ version: m.version, reason: 'sửa' }) // notify bỏ qua = mặc định true
      .expect(200);
    const ob = await pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE topic='booking_cancelled' AND payload->>'bookingId'=$1`,
      [b.bookingId],
    );
    expect(ob.rows[0].n).toBe(1);
  });
});
