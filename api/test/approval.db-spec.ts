import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.4 — hàng đợi Admin duyệt/từ chối request >48h giữ chỗ (FR-13/46/49).
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[approval.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[approval.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const asAdmin = { 'x-dev-user-sub': 'adm-1', 'x-dev-role': 'admin' };
const asAdmin2 = { 'x-dev-user-sub': 'adm-2', 'x-dev-role': 'admin' };
const asLong = { 'x-dev-user-sub': 'mem-long', 'x-dev-role': 'member' };

describe('Admin duyệt/từ chối request >48h (story 3.4)', () => {
  let app: INestApplication;
  let pool: Pool;
  let machine: string;

  /** Tạo ticket pending_approval + booking held (mô phỏng submit >48h 3.1c). */
  const mkHeld = async (from: string, to: string) => {
    const t = await pool.query<{ id: string; version: number }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('pending_approval','mem-long','mem-long') RETURNING id, version`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','held', tstzrange($3,$4,'[)'))`,
      [t.rows[0].id, machine, from, to],
    );
    return t.rows[0];
  };

  const submitLong = (from: string, to: string) =>
    request(app.getHttpServer())
      .post('/api/booking')
      .set(asLong)
      .send({ assetId: machine, from, to });

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
      `INSERT INTO users (sub, email, full_name, role, can_long_term) VALUES
         ('mem-long','l@t.vn','Long Member','member',true),
         ('mem-other','o@t.vn','Other','member',false)`,
    );
    const a = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ('AP-1','laptop',true,'in_use') RETURNING id`,
    );
    machine = a.rows[0].id;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('submit >48h (quyền dài hạn) → held busy máy với người khác (AC 1)', async () => {
    const res = await submitLong(iso(100 * H), iso(160 * H)).expect(201);
    expect(res.body.bookingState).toBe('held');
    // người khác xem availability khung đó → máy KHÔNG rảnh (held chiếm chỗ)
    const av = await request(app.getHttpServer())
      .get('/api/booking/availability')
      .query({ from: iso(100 * H), to: iso(160 * H) })
      .set({ 'x-dev-user-sub': 'mem-other', 'x-dev-role': 'member' })
      .expect(200);
    expect(
      (av.body as Array<{ code: string }>).some((m) => m.code === 'AP-1'),
    ).toBe(false);
    // dọn để test sau không dính quota/khung
    await pool.query(
      `UPDATE booking SET state='cancelled' WHERE ticket_id=$1`,
      [res.body.ticketId],
    );
    await pool.query(`UPDATE ticket SET state='cancelled' WHERE id=$1`, [
      res.body.ticketId,
    ]);
  });

  it('duyệt → ticket awaiting_pickup + booking pending (AC 2)', async () => {
    const t = await mkHeld(iso(200 * H), iso(260 * H));
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/approve`)
      .set(asAdmin)
      .send({ version: t.version })
      .expect(200);
    const tk = await pool.query(`SELECT state FROM ticket WHERE id=$1`, [t.id]);
    const bk = await pool.query(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [t.id],
    );
    expect(tk.rows[0].state).toBe('awaiting_pickup');
    expect(bk.rows[0].state).toBe('pending');
  });

  it('từ chối (bắt buộc lý do) → rejected + booking cancelled + khung nhả (AC 3)', async () => {
    const t = await mkHeld(iso(300 * H), iso(360 * H));
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/reject`)
      .set(asAdmin)
      .send({ version: t.version, reason: 'Máy dành cho việc khác' })
      .expect(200);
    const tk = await pool.query(
      `SELECT state, reject_reason FROM ticket WHERE id=$1`,
      [t.id],
    );
    const bk = await pool.query(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [t.id],
    );
    expect(tk.rows[0].state).toBe('rejected');
    expect(tk.rows[0].reject_reason).toBe('Máy dành cho việc khác');
    expect(bk.rows[0].state).toBe('cancelled');
    // khung nhả
    const av = await request(app.getHttpServer())
      .get('/api/booking/availability')
      .query({ from: iso(300 * H), to: iso(360 * H) })
      .set(asLong)
      .expect(200);
    expect(
      (av.body as Array<{ code: string }>).some((m) => m.code === 'AP-1'),
    ).toBe(true);
  });

  it('reject thiếu reason → 400 (AC 3)', async () => {
    const t = await mkHeld(iso(400 * H), iso(460 * H));
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/reject`)
      .set(asAdmin)
      .send({ version: t.version })
      .expect(400);
  });

  it('2 Admin cùng duyệt → 1 thắng, 1 nhận 409 STALE_VERSION + audit lần thua (AC 4)', async () => {
    const t = await mkHeld(iso(500 * H), iso(560 * H));
    const [r1, r2] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/admin/tickets/${t.id}/approve`)
        .set(asAdmin)
        .send({ version: t.version }),
      request(app.getHttpServer())
        .post(`/api/admin/tickets/${t.id}/reject`)
        .set(asAdmin2)
        .send({ version: t.version, reason: 'x' }),
    ]);
    const codes = [r1.status, r2.status].sort((a, b) => a - b);
    expect(codes).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    // Cả 2 cầm CÙNG version cũ → người thua nhận đúng STALE_VERSION (AC 4)
    expect((loser.body as { code: string }).code).toBe('STALE_VERSION');
    // AC 4: audit ghi CẢ hai lần thử — winner (approve/reject) + loser (*_failed)
    const audit = await pool.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE object_id=$1`,
      [t.id],
    );
    const actions = audit.rows.map((r) => r.action);
    const hasWinner = actions.some(
      (a) => a === 'tickets.approve' || a === 'tickets.reject',
    );
    const hasFailed = actions.some((a) => a.endsWith('_failed'));
    expect(hasWinner).toBe(true);
    expect(hasFailed).toBe(true);
  });

  it('duyệt ticket KHÔNG tồn tại → 404 TICKET_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/admin/tickets/2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f/approve`)
      .set(asAdmin)
      .send({ version: 1 })
      .expect(404);
    expect((res.body as { code: string }).code).toBe('TICKET_NOT_FOUND');
  });

  it('duyệt ticket đã rời pending_approval (version đúng) → 409 INVALID_STATE', async () => {
    const t = await mkHeld(iso(900 * H - 200 * H), iso(900 * H - 100 * H));
    // duyệt lần 1 → awaiting_pickup (version thành 2)
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/approve`)
      .set(asAdmin)
      .send({ version: t.version })
      .expect(200);
    // duyệt lần 2 với version MỚI đúng (2) nhưng state đã awaiting_pickup → INVALID_STATE
    const res = await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/approve`)
      .set(asAdmin)
      .send({ version: t.version + 1 })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('INVALID_STATE');
  });

  it('duyệt/từ chối ticket ĐỊNH KỲ qua luồng thẳng → 409 INVALID_STATE (audit H4)', async () => {
    // Chuỗi định kỳ phải qua approveChain/rejectChain (deriveParentState AD-4),
    // KHÔNG được duyệt thẳng qua approveRequest/rejectRequest.
    const t = await pool.query<{ id: string; version: number }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub)
       VALUES ('recurring','pending_approval','mem-long','mem-long') RETURNING id, version`,
    );
    const { id, version } = t.rows[0];
    const approve = await request(app.getHttpServer())
      .post(`/api/admin/tickets/${id}/approve`)
      .set(asAdmin)
      .send({ version })
      .expect(409);
    expect((approve.body as { code: string }).code).toBe('INVALID_STATE');
    const reject = await request(app.getHttpServer())
      .post(`/api/admin/tickets/${id}/reject`)
      .set(asAdmin)
      .send({ version, reason: 'x' })
      .expect(409);
    expect((reject.body as { code: string }).code).toBe('INVALID_STATE');
    // dọn
    await pool.query(`UPDATE ticket SET state='cancelled' WHERE id=$1`, [id]);
  });

  it('giờ nhận đã quá khứ → duyệt bị từ chối 409 PICKUP_PASSED (AC 5)', async () => {
    const t = await mkHeld(iso(-2 * H), iso(60 * H));
    const res = await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/approve`)
      .set(asAdmin)
      .send({ version: t.version })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('PICKUP_PASSED');
  });

  it('rejected KHÔNG đếm quota active (AC 3)', async () => {
    // User + máy RIÊNG tránh nhiễu; khung trong window 30 ngày (<720h), >48h, không chồng.
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role, can_long_term) VALUES ('mem-q4','q4@t.vn','Q4','member',true)`,
    );
    const m2 = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ('AP-Q4','laptop',true,'in_use') RETURNING id`,
    );
    const mq = m2.rows[0].id;
    const q = { 'x-dev-user-sub': 'mem-q4', 'x-dev-role': 'member' };
    const s1 = await request(app.getHttpServer())
      .post('/api/booking')
      .set(q)
      .send({ assetId: mq, from: iso(100 * H), to: iso(160 * H) })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(q)
      .send({ assetId: mq, from: iso(200 * H), to: iso(260 * H) })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(q)
      .send({ assetId: mq, from: iso(300 * H), to: iso(360 * H) })
      .expect(409);
    // Admin reject s1 → quota giải phóng (rejected không đếm ACTIVE)
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${s1.body.ticketId}/reject`)
      .set(asAdmin)
      .send({ version: 1, reason: 'nhả slot' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(q)
      .send({ assetId: mq, from: iso(300 * H), to: iso(360 * H) })
      .expect(201);
  });
});
