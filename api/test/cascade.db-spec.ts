import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.10 — cascade khóa/gỡ pool/thanh lý (orchestrator Tickets→Assets, AD-1).
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[cascade.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[cascade.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const asAdmin = { 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' };

describe('Cascade khóa/gỡ pool/thanh lý (story 3.10)', () => {
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

  it('khóa máy → held/pending future+stale cancelled + ticket cancelled + outbox (AC 1/2)', async () => {
    const m = await newMachine('CS-1');
    // pending future
    const b1 = await mkBooking(
      m.id,
      'awaiting_pickup',
      'pending',
      iso(10 * H),
      iso(12 * H),
    );
    // held stale-past-pickup (chưa giao) — khung KHÔNG chồng b1
    const b2 = await mkBooking(
      m.id,
      'pending_approval',
      'held',
      iso(-2 * H),
      iso(5 * H),
    );
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${m.id}/lock`)
      .set(asAdmin)
      .send({ version: m.version, reason: 'Đem sửa' })
      .expect(200);
    // asset locked
    const a = await pool.query(`SELECT status FROM assets WHERE id=$1`, [m.id]);
    expect(a.rows[0].status).toBe('locked_repair');
    // cả 2 booking cancelled, ticket cancelled
    for (const b of [b1, b2]) {
      const bk = await pool.query(`SELECT state FROM booking WHERE id=$1`, [
        b.bookingId,
      ]);
      const tk = await pool.query(`SELECT state FROM ticket WHERE id=$1`, [
        b.ticketId,
      ]);
      expect(bk.rows[0].state).toBe('cancelled');
      expect(tk.rows[0].state).toBe('cancelled');
    }
    // outbox booking_cancelled cho mỗi booking (FR-27)
    const ob = await pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE topic='booking_cancelled' AND payload->>'bookingId' IN ($1,$2)`,
      [b1.bookingId, b2.bookingId],
    );
    expect(ob.rows[0].n).toBe(2);
  });

  it('khóa máy A → booking held/pending của máy B KHÔNG bị đụng (asset_id filter)', async () => {
    const mA = await newMachine('CS-A');
    const mB = await newMachine('CS-B');
    const bB = await mkBooking(
      mB.id,
      'awaiting_pickup',
      'pending',
      iso(10 * H),
      iso(12 * H),
    );
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${mA.id}/lock`)
      .set(asAdmin)
      .send({ version: mA.version, reason: 'chỉ máy A' })
      .expect(200);
    const bk = await pool.query(`SELECT state FROM booking WHERE id=$1`, [
      bB.bookingId,
    ]);
    expect(bk.rows[0].state).toBe('pending'); // máy B không bị đụng
  });

  it('máy đang mượn (delivered/in_use) → khóa KHÔNG hủy booking delivered (AC 3)', async () => {
    const m = await newMachine('CS-2');
    const b = await mkBooking(
      m.id,
      'in_use',
      'delivered',
      iso(-1 * H),
      iso(20 * H),
    );
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${m.id}/lock`)
      .set(asAdmin)
      .send({ version: m.version, reason: 'sửa' })
      .expect(200);
    const bk = await pool.query(`SELECT state FROM booking WHERE id=$1`, [
      b.bookingId,
    ]);
    const tk = await pool.query(`SELECT state FROM ticket WHERE id=$1`, [
      b.ticketId,
    ]);
    expect(bk.rows[0].state).toBe('delivered'); // GIỮ — Admin thu hồi tay
    expect(tk.rows[0].state).toBe('in_use');
  });

  it('thanh lý → cascade hủy booking + detach software (AC 1/2)', async () => {
    const m = await newMachine('CS-3');
    const b = await mkBooking(
      m.id,
      'awaiting_pickup',
      'pending',
      iso(10 * H),
      iso(12 * H),
    );
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${m.id}/dispose`)
      .set(asAdmin)
      .send({ version: m.version })
      .expect(200);
    const a = await pool.query(`SELECT status FROM assets WHERE id=$1`, [m.id]);
    expect(a.rows[0].status).toBe('disposed');
    const bk = await pool.query(`SELECT state FROM booking WHERE id=$1`, [
      b.bookingId,
    ]);
    expect(bk.rows[0].state).toBe('cancelled');
  });

  it('gỡ pool (isPool=false) → cascade hủy booking (AC 1/2)', async () => {
    const m = await newMachine('CS-4');
    const b = await mkBooking(
      m.id,
      'awaiting_pickup',
      'pending',
      iso(10 * H),
      iso(12 * H),
    );
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${m.id}/pool`)
      .set(asAdmin)
      .send({ version: m.version, isPool: false })
      .expect(200);
    const bk = await pool.query(`SELECT state FROM booking WHERE id=$1`, [
      b.bookingId,
    ]);
    expect(bk.rows[0].state).toBe('cancelled');
  });

  it('mở khóa → KHÔNG hủy booking (AC — unlock không cascade)', async () => {
    // Tạo máy in_use + booking trước, RỒI khóa (qua pool, bypass trigger) — vì trigger
    // AD-15 chặn INSERT booking lên máy đang khóa.
    const m = await newMachine('CS-5');
    const b = await mkBooking(
      m.id,
      'awaiting_pickup',
      'pending',
      iso(10 * H),
      iso(12 * H),
    );
    await pool.query(
      `UPDATE assets SET status='locked_repair', version=version+1 WHERE id=$1`,
      [m.id],
    );
    const cur = await pool.query<{ version: number }>(
      `SELECT version FROM assets WHERE id=$1`,
      [m.id],
    );
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${m.id}/unlock`)
      .set(asAdmin)
      .send({ version: cur.rows[0].version })
      .expect(200);
    const bk = await pool.query(`SELECT state FROM booking WHERE id=$1`, [
      b.bookingId,
    ]);
    expect(bk.rows[0].state).toBe('pending'); // unlock KHÔNG cascade
  });

  it('race: submit booking sau khi máy đã khóa → 409 ASSET_UNAVAILABLE (AC 4, AD-15)', async () => {
    const m = await newMachine('CS-6');
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${m.id}/lock`)
      .set(asAdmin)
      .send({ version: m.version, reason: 'khóa' })
      .expect(200);
    // member RIÊNG (không dính quota tích lũy) submit sau khi khóa → trigger từ chối
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-race','r@t.vn','Race','member')`,
    );
    const res = await request(app.getHttpServer())
      .post('/api/booking')
      .set({ 'x-dev-user-sub': 'mem-race', 'x-dev-role': 'member' })
      .send({ assetId: m.id, from: iso(10 * H), to: iso(11 * H) })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('ASSET_UNAVAILABLE');
  });

  it('cùng tx: STALE_VERSION khi khóa → KHÔNG hủy booking (nguyên tử, AC 1)', async () => {
    const m = await newMachine('CS-7');
    const b = await mkBooking(
      m.id,
      'awaiting_pickup',
      'pending',
      iso(10 * H),
      iso(12 * H),
    );
    // version sai → STALE_VERSION, cả tx rollback → booking KHÔNG bị hủy
    const res = await request(app.getHttpServer())
      .post(`/api/admin/assets/${m.id}/lock`)
      .set(asAdmin)
      .send({ version: m.version + 99, reason: 'x' })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('STALE_VERSION');
    const bk = await pool.query(`SELECT state FROM booking WHERE id=$1`, [
      b.bookingId,
    ]);
    expect(bk.rows[0].state).toBe('pending'); // KHÔNG bị hủy (rollback)
  });
});
