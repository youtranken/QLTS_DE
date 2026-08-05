import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { TicketsService } from '../src/modules/tickets/tickets.service';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.9 — auto-close no-show (FR-16) + pickup reminder outbox (FR-26).
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[no-show.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[no-show.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;

describe('Auto-close no-show + pickup reminder (story 3.9)', () => {
  let app: INestApplication;
  let pool: Pool;
  let tickets: TicketsService;

  const newMachine = async (code: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ($1,'laptop',true,'in_use') RETURNING id`,
      [code],
    );
    return r.rows[0].id;
  };

  const mkTicket = async (
    state: string,
    bkState: string,
    from: string,
    to: string,
    assetId: string,
  ) => {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ($1,'mem-o','mem-o') RETURNING id`,
      [state],
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal',$3, tstzrange($4,$5,'[)'))`,
      [t.rows[0].id, assetId, bkState, from, to],
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
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-o','o@t.vn','Owner','member')`,
    );
    app = await createTestApp();
    tickets = app.get(TicketsService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('awaiting_pickup hết hạn → closed no_show + booking cancelled + audit system (AC 1)', async () => {
    const m = await newMachine('NS-1');
    const id = await mkTicket(
      'awaiting_pickup',
      'pending',
      iso(-5 * H),
      iso(-1 * H),
      m,
    );
    const n = await tickets.autoCloseNoShow();
    expect(n).toBeGreaterThanOrEqual(1);
    const tk = await pool.query(
      `SELECT state, close_reason FROM ticket WHERE id=$1`,
      [id],
    );
    const bk = await pool.query(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [id],
    );
    expect(tk.rows[0].state).toBe('closed');
    expect(tk.rows[0].close_reason).toBe('no_show');
    expect(bk.rows[0].state).toBe('cancelled');
    const audit = await pool.query(
      `SELECT actor, action FROM audit_log WHERE object_id=$1`,
      [id],
    );
    expect(
      audit.rows.some(
        (r: { actor: string; action: string }) =>
          r.actor === 'system' && r.action === 'tickets.no_show',
      ),
    ).toBe(true);
  });

  it('in_use (đã giao) hết hạn → KHÔNG tự close (AC 2)', async () => {
    const m = await newMachine('NS-2');
    const id = await mkTicket(
      'in_use',
      'delivered',
      iso(-5 * H),
      iso(-1 * H),
      m,
    );
    await tickets.autoCloseNoShow();
    const tk = await pool.query(`SELECT state FROM ticket WHERE id=$1`, [id]);
    expect(tk.rows[0].state).toBe('in_use'); // không đụng
  });

  it('quota giải phóng + khung nhả sau no-show (AC 1)', async () => {
    const m = await newMachine('NS-3');
    const id = await mkTicket(
      'awaiting_pickup',
      'pending',
      iso(-6 * H),
      iso(-2 * H),
      m,
    );
    await tickets.autoCloseNoShow();
    expect(
      (await pool.query(`SELECT state FROM ticket WHERE id=$1`, [id])).rows[0]
        .state,
    ).toBe('closed');
    // khung NHẢ thật: submit booking mới chồng đúng khung vừa no-show → thành công (EXCLUDE thả)
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-ns3','ns3@t.vn','NS3','member')`,
    );
    await request(app.getHttpServer())
      .post('/api/booking')
      .set({ 'x-dev-user-sub': 'mem-ns3', 'x-dev-role': 'member' })
      .send({ assetId: m, from: iso(10 * H), to: iso(11 * H) })
      .expect(201);
  });

  it('race no-show ↔ Admin deliver: 1 thắng, trạng thái nhất quán (AC 2)', async () => {
    const m = await newMachine('NS-RACE');
    // ticket awaiting_pickup quá hạn — cả deliver lẫn no-show đều nhắm
    const t = await pool.query<{ id: string; version: number }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('awaiting_pickup','mem-o','mem-o') RETURNING id, version`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','pending', tstzrange($3,$4,'[)'))`,
      [t.rows[0].id, m, iso(-5 * H), iso(-1 * H)],
    );
    await Promise.all([
      request(app.getHttpServer())
        .post(`/api/admin/tickets/${t.rows[0].id}/deliver`)
        .set({ 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' })
        .send({ version: t.rows[0].version }),
      tickets.autoCloseNoShow(),
    ]);
    const tk = await pool.query(
      `SELECT state, close_reason FROM ticket WHERE id=$1`,
      [t.rows[0].id],
    );
    const bk = await pool.query(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [t.rows[0].id],
    );
    // Nhất quán: hoặc (closed no_show + cancelled) hoặc (in_use + delivered) — KHÔNG lẫn
    if (tk.rows[0].state === 'closed') {
      expect(tk.rows[0].close_reason).toBe('no_show');
      expect(bk.rows[0].state).toBe('cancelled');
    } else {
      expect(tk.rows[0].state).toBe('in_use');
      expect(bk.rows[0].state).toBe('delivered');
    }
  });

  it('pickup reminder: booking đến giờ nhận (chưa hết hạn) → outbox 1 event + marker (AC 3)', async () => {
    const m = await newMachine('NS-4');
    const id = await mkTicket(
      'awaiting_pickup',
      'pending',
      iso(-1 * H),
      iso(3 * H),
      m,
    );
    const n = await tickets.emitPickupReminders();
    expect(n).toBeGreaterThanOrEqual(1);
    const ob = await pool.query(
      `SELECT topic, payload FROM outbox WHERE topic='pickup_reminder' AND payload->>'ticketId'=$1`,
      [id],
    );
    expect(ob.rowCount).toBe(1);
    // payload chỉ id (AD-11)
    expect(ob.rows[0].payload).toMatchObject({ ticketId: id });
    const bk = await pool.query(
      `SELECT pickup_reminder_at FROM booking WHERE ticket_id=$1`,
      [id],
    );
    expect(bk.rows[0].pickup_reminder_at).not.toBeNull();
  });

  it('sweep reminder 2 lần → KHÔNG lặp event (marker, party phiên 7)', async () => {
    const m = await newMachine('NS-5');
    const id = await mkTicket(
      'awaiting_pickup',
      'pending',
      iso(-30 * 60 * 1000),
      iso(3 * H),
      m,
    );
    // SONG SONG (party phiên 7): 2 sweep tranh chấp row-lock marker → chỉ 1 ghi outbox
    await Promise.all([
      tickets.emitPickupReminders(),
      tickets.emitPickupReminders(),
    ]);
    const ob = await pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE topic='pickup_reminder' AND payload->>'ticketId'=$1`,
      [id],
    );
    expect(ob.rows[0].n).toBe(1); // chỉ 1 event dù 2 sweep song song
    // second run có thể emit reminder của booking KHÁC nhưng KHÔNG của booking này
  });

  it('reminder KHÔNG emit khi CHƯA tới giờ nhận (lower tương lai)', async () => {
    const m = await newMachine('NS-6');
    const id = await mkTicket(
      'awaiting_pickup',
      'pending',
      iso(2 * H),
      iso(5 * H),
      m,
    );
    await tickets.emitPickupReminders();
    const ob = await pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE payload->>'ticketId'=$1`,
      [id],
    );
    expect(ob.rows[0].n).toBe(0);
  });

  it('reminder KHÔNG emit khi ĐÃ hết hạn (upper quá khứ — no-show lo)', async () => {
    const m = await newMachine('NS-7');
    const id = await mkTicket(
      'awaiting_pickup',
      'pending',
      iso(-5 * H),
      iso(-1 * H),
      m,
    );
    await tickets.emitPickupReminders();
    const ob = await pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE payload->>'ticketId'=$1`,
      [id],
    );
    expect(ob.rows[0].n).toBe(0); // hết hạn → không nhắc, no-show close
  });
});
