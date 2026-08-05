import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { TicketsService } from '../src/modules/tickets/tickets.service';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.5b — auto-expire request pending_approval quá giờ nhận + expire-on-conflict.
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[expire.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[expire.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;

describe('Auto-expire request chờ duyệt (story 3.5b)', () => {
  let app: INestApplication;
  let pool: Pool;
  let tickets: TicketsService;
  let machine: string;

  /** ticket pending_approval + booking held tại khung cho trước. */
  const mkHeld = async (from: string, to: string) => {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('pending_approval','mem-l','mem-l') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','held', tstzrange($3,$4,'[)'))`,
      [t.rows[0].id, machine, from, to],
    );
    return t.rows[0].id;
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
      `INSERT INTO users (sub, email, full_name, role, can_long_term) VALUES
         ('mem-l','l@t.vn','L','member',true),
         ('mem-s','s@t.vn','S','member',true)`,
    );
    const a = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ('EX-1','laptop',true,'in_use') RETURNING id`,
    );
    machine = a.rows[0].id;
    app = await createTestApp();
    tickets = app.get(TicketsService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('sweep expire pending_approval quá giờ → cancelled + booking cancelled + audit system (AC 1)', async () => {
    const id = await mkHeld(iso(-2 * H), iso(60 * H)); // giờ nhận 2h trước
    const n = await tickets.expireStalePendingApprovals();
    expect(n).toBeGreaterThanOrEqual(1);
    const tk = await pool.query(`SELECT state FROM ticket WHERE id=$1`, [id]);
    const bk = await pool.query(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [id],
    );
    expect(tk.rows[0].state).toBe('cancelled');
    expect(bk.rows[0].state).toBe('cancelled');
    const audit = await pool.query(
      `SELECT actor, action FROM audit_log WHERE object_id=$1`,
      [id],
    );
    expect(
      audit.rows.some(
        (r: { actor: string; action: string }) =>
          r.actor === 'system' && r.action === 'tickets.auto_expire',
      ),
    ).toBe(true);
  });

  it('KHÔNG đụng pending_approval còn hạn (giờ nhận tương lai) (AC 1)', async () => {
    const id = await mkHeld(iso(100 * H), iso(160 * H)); // còn hạn
    await tickets.expireStalePendingApprovals();
    const tk = await pool.query(`SELECT state FROM ticket WHERE id=$1`, [id]);
    expect(tk.rows[0].state).toBe('pending_approval');
    await pool.query(
      `UPDATE booking SET state='cancelled' WHERE ticket_id=$1`,
      [id],
    );
    await pool.query(`UPDATE ticket SET state='cancelled' WHERE id=$1`, [id]);
  });

  it('idempotent: chạy sweep 2 lần không đổi thêm (AC 1)', async () => {
    await mkHeld(iso(-3 * H), iso(50 * H));
    const first = await tickets.expireStalePendingApprovals();
    const second = await tickets.expireStalePendingApprovals();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(second).toBe(0); // lần 2 không còn gì để expire
  });

  it('quota giải phóng sau khi sweep expire (AC 1)', async () => {
    // user riêng đầy quota (2 held), 1 quá giờ → sweep expire → submit mới lọt
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role, can_long_term) VALUES ('mem-eq','eq@t.vn','EQ','member',true)`,
    );
    const mkHeldFor = async (sub: string, from: string, to: string) => {
      const t = await pool.query<{ id: string }>(
        `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('pending_approval',$1,$1) RETURNING id`,
        [sub],
      );
      await pool.query(
        `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','held', tstzrange($3,$4,'[)'))`,
        [t.rows[0].id, machine, from, to],
      );
    };
    await mkHeldFor('mem-eq', iso(-4 * H), iso(50 * H)); // quá giờ → sẽ expire
    await mkHeldFor('mem-eq', iso(400 * H), iso(460 * H)); // còn hạn
    const eq = { 'x-dev-user-sub': 'mem-eq', 'x-dev-role': 'member' };
    // đầy quota (2 active) → submit thứ 3 chặn
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(eq)
      .send({ assetId: machine, from: iso(500 * H), to: iso(501 * H) })
      .expect(409);
    // sweep expire ticket quá giờ → còn 1 active
    await tickets.expireStalePendingApprovals();
    // giờ submit lọt
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(eq)
      .send({ assetId: machine, from: iso(500 * H), to: iso(501 * H) })
      .expect(201);
  });

  it('expire-on-conflict: submit đụng held quá giờ → held bị expire + submit thành công (AC 2)', async () => {
    // held CŨ quá giờ nhận chồng khung tương lai member muốn đặt
    const staleId = await mkHeld(iso(-1 * H), iso(200 * H));
    // member khác submit đúng khung đó (≤48h trong tương lai) → expire-on-conflict
    const res = await request(app.getHttpServer())
      .post('/api/booking')
      .set({ 'x-dev-user-sub': 'mem-s', 'x-dev-role': 'member' })
      .send({ assetId: machine, from: iso(150 * H), to: iso(151 * H) })
      .expect(201);
    expect(res.body.bookingState).toBe('pending'); // ≤48h auto-approve
    // held cũ đã bị expire (cancelled)
    const stale = await pool.query(`SELECT state FROM ticket WHERE id=$1`, [
      staleId,
    ]);
    expect(stale.rows[0].state).toBe('cancelled');
  });

  it('expire-on-conflict KHÔNG cứu được khi có booking CÒN HẠN chồng → SLOT_TAKEN (AC 2)', async () => {
    // booking pending (awaiting_pickup) CÒN HẠN chồng khung → không phải held quá giờ
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('awaiting_pickup','mem-l','mem-l') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','pending', tstzrange($3,$4,'[)'))`,
      [t.rows[0].id, machine, iso(300 * H), iso(360 * H)],
    );
    const res = await request(app.getHttpServer())
      .post('/api/booking')
      .set({ 'x-dev-user-sub': 'mem-s', 'x-dev-role': 'member' })
      .send({ assetId: machine, from: iso(310 * H), to: iso(320 * H) })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('SLOT_TAKEN');
  });
});
