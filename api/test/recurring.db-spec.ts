import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { RecurringService } from '../src/modules/tickets/recurring.service';
import { createTestApp } from './test-app.helper';

/** Story 4.4 — tạo chuỗi mượn định kỳ (all-or-nothing, AD-3; sweep anchor party 7). */
if (!process.env.DATABASE_URL) {
  throw new Error('[recurring.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[recurring.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const D = 24 * 60 * 60 * 1000;
const asMem = { 'x-dev-user-sub': 'mem-r', 'x-dev-role': 'member' };
// buổi ngày VN (days từ nay), giờ nhận sh → giờ trả eh (offset +07:00)
const vnDatePlus = (days: number) =>
  new Date(Date.now() + days * D).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
  });
const ses = (days: number, sh: number, eh: number) => ({
  from: `${vnDatePlus(days)}T${String(sh).padStart(2, '0')}:00:00+07:00`,
  to: `${vnDatePlus(days)}T${String(eh).padStart(2, '0')}:00:00+07:00`,
});

describe('Chuỗi mượn định kỳ (story 4.4)', () => {
  let app: INestApplication;
  let pool: Pool;
  let recurring: RecurringService;

  const newMachine = async (code: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ($1,'laptop',true,'in_use') RETURNING id`,
      [code],
    );
    return r.rows[0].id;
  };
  const submit = (assetId: string, sessions: { from: string; to: string }[]) =>
    request(app.getHttpServer())
      .post('/api/booking/recurring')
      .set(asMem)
      .send({ assetId, sessions });

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
      `INSERT INTO users (sub, email, full_name, role, can_recurring) VALUES
        ('mem-r','r@t.vn','Member R','member', true),
        ('mem-n','n@t.vn','Member N','member', false)`,
    );
    app = await createTestApp();
    recurring = app.get(RecurringService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('AC3: chuỗi hợp lệ → 1 ticket recurring + N booking recurring held', async () => {
    const m = await newMachine('RC-1');
    const res = await submit(m, [ses(2, 14, 16), ses(9, 14, 16)]).expect(201);
    expect((res.body as { count: number }).count).toBe(2);
    const tk = await pool.query<{ kind: string; state: string }>(
      `SELECT kind, state FROM ticket WHERE id=$1`,
      [(res.body as { ticketId: string }).ticketId],
    );
    expect(tk.rows[0].kind).toBe('recurring');
    expect(tk.rows[0].state).toBe('pending_approval');
    const bk = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM booking WHERE ticket_id=$1 AND kind='recurring' AND state='held'`,
      [(res.body as { ticketId: string }).ticketId],
    );
    expect(bk.rows[0].n).toBe(2);
  });

  it('AC2: 2 buổi cùng tuần → 400 RECUR_WEEK_DUP', async () => {
    const m = await newMachine('RC-2');
    const res = await submit(m, [ses(3, 14, 16), ses(3, 8, 10)]).expect(400);
    expect((res.body as { code: string }).code).toBe('RECUR_WEEK_DUP');
  });

  it('AC2: tổng span > 30 ngày → 400 RECUR_SPAN', async () => {
    const m = await newMachine('RC-3');
    const res = await submit(m, [ses(2, 14, 16), ses(35, 14, 16)]).expect(400);
    expect((res.body as { code: string }).code).toBe('RECUR_SPAN');
  });

  it('AC3: buổi kẹt EXCLUDE → 409 SLOT_TAKEN{stuckSession} + rollback CẢ chuỗi', async () => {
    const m = await newMachine('RC-4');
    // booking khác của mem-n chiếm đúng khung buổi 2 (day9 14-16)
    const s2 = ses(9, 14, 16);
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('awaiting_pickup','mem-n','mem-n') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','pending', tstzrange($3,$4,'[)'))`,
      [t.rows[0].id, m, s2.from, s2.to],
    );
    const before = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ticket WHERE borrower_sub='mem-r'`,
    );
    const res = await submit(m, [ses(2, 14, 16), s2]).expect(409);
    expect((res.body as { code: string; stuckSession: number }).code).toBe(
      'SLOT_TAKEN',
    );
    expect((res.body as { stuckSession: number }).stuckSession).toBe(1);
    // rollback: KHÔNG có ticket recurring nào của mem-r được ghi
    const after = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ticket WHERE borrower_sub='mem-r'`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('AC1: member không có quyền định kỳ → 403 RECUR_NOT_ALLOWED', async () => {
    const m = await newMachine('RC-5');
    const res = await request(app.getHttpServer())
      .post('/api/booking/recurring')
      .set({ 'x-dev-user-sub': 'mem-n', 'x-dev-role': 'member' })
      .send({ assetId: m, sessions: [ses(2, 14, 16)] })
      .expect(403);
    expect((res.body as { code: string }).code).toBe('RECUR_NOT_ALLOWED');
  });

  it('AC4: sweep — chuỗi có buổi đầu quá giờ nhận → CẢ CHUỖI cancelled', async () => {
    const m = await newMachine('RC-6');
    // insert trực tiếp (bypass window) chuỗi: buổi 1 quá khứ, buổi 2 tương lai
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub) VALUES ('recurring','pending_approval','mem-r','mem-r') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES
        ($1,$2,'recurring','held', tstzrange(now()-interval '1 hour', now()+interval '1 hour','[)')),
        ($1,$2,'recurring','held', tstzrange(now()+interval '7 days', now()+interval '7 days 2 hours','[)'))`,
      [t.rows[0].id, m],
    );
    const n = await recurring.expireStalePendingRecurring();
    expect(n).toBe(1);
    const tk = await pool.query<{ state: string }>(
      `SELECT state FROM ticket WHERE id=$1`,
      [t.rows[0].id],
    );
    expect(tk.rows[0].state).toBe('cancelled');
    const held = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM booking WHERE ticket_id=$1 AND state='held'`,
      [t.rows[0].id],
    );
    expect(held.rows[0].n).toBe(0);
  });

  it('AC4 (race anchor): buổi-anchor bị hủy → anchor dời buổi sau (tương lai) → KHÔNG expire oan', async () => {
    const m = await newMachine('RC-7');
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub) VALUES ('recurring','pending_approval','mem-r','mem-r') RETURNING id`,
    );
    // buổi 1 quá khứ NHƯNG đã cancelled (member vừa hủy); buổi 2 tương lai còn held
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES
        ($1,$2,'recurring','cancelled', tstzrange(now()-interval '1 hour', now()+interval '1 hour','[)')),
        ($1,$2,'recurring','held', tstzrange(now()+interval '7 days', now()+interval '7 days 2 hours','[)'))`,
      [t.rows[0].id, m],
    );
    const n = await recurring.expireStalePendingRecurring();
    expect(n).toBe(0); // anchor sống sớm nhất ở tương lai → không expire
    const tk = await pool.query<{ state: string }>(
      `SELECT state FROM ticket WHERE id=$1`,
      [t.rows[0].id],
    );
    expect(tk.rows[0].state).toBe('pending_approval');
  });
});
