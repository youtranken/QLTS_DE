import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 4.1 — member xin gia hạn (extension booking, FR-18/19/20/47, AD-3). */
if (!process.env.DATABASE_URL) {
  throw new Error('[extension.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[extension.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const H = 60 * 60 * 1000;
const D = 24 * H;
const asMem = { 'x-dev-user-sub': 'mem-x', 'x-dev-role': 'member' };

describe('Member xin gia hạn (story 4.1)', () => {
  let app: INestApplication;
  let pool: Pool;

  const newMachine = async (code: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ($1,'laptop',true,'in_use') RETURNING id`,
      [code],
    );
    return r.rows[0].id;
  };

  // Ticket in_use + booking delivered [from,to) cho member sub
  const deliverTo = async (
    assetId: string,
    sub: string,
    from: string,
    to: string,
  ) => {
    const t = await pool.query<{ id: string; version: number }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('in_use',$1,$1) RETURNING id, version`,
      [sub],
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','delivered', tstzrange($3,$4,'[)'))`,
      [t.rows[0].id, assetId, from, to],
    );
    return { ticketId: t.rows[0].id, version: t.rows[0].version };
  };

  const extend = (
    ticketId: string,
    newDue: string,
    version: number,
    hdr = asMem,
  ) =>
    request(app.getHttpServer())
      .post(`/api/booking/my-tickets/${ticketId}/extension`)
      .set(hdr)
      .send({ newDue, version });

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
      `INSERT INTO users (sub, email, full_name, role) VALUES
        ('mem-x','x@t.vn','Member X','member'),
        ('mem-y','y@t.vn','Member Y','member')`,
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('AC3: gia hạn hợp lệ → dòng extension held period=[hạn_cũ,hạn_mới), KHÔNG mail (FR-47)', async () => {
    const m = await newMachine('EX-1');
    const oldTo = iso(20 * H);
    const tk = await deliverTo(m, 'mem-x', iso(-1 * H), oldTo);
    const res = await extend(
      tk.ticketId,
      iso(20 * H + 1 * D),
      tk.version,
    ).expect(201);
    const bk = await pool.query<{
      state: string;
      from_ts: string;
      to_ts: string;
    }>(
      `SELECT state, lower(period) AS from_ts, upper(period) AS to_ts FROM booking WHERE id=$1`,
      [(res.body as { id: string }).id],
    );
    expect(bk.rows[0].state).toBe('held');
    expect(new Date(bk.rows[0].from_ts).getTime()).toBe(
      new Date(oldTo).getTime(),
    );
    // FR-47: không outbox event nào cho luồng gia hạn
    const ob = await pool.query(`SELECT count(*)::int AS n FROM outbox`);
    expect(ob.rows[0].n).toBe(0);
  });

  it('AC1: hạn mới vượt số ngày/lần config → 400 EXTENSION_TOO_LONG', async () => {
    const m = await newMachine('EX-2');
    const tk = await deliverTo(m, 'mem-x', iso(-1 * H), iso(20 * H));
    const res = await extend(
      tk.ticketId,
      iso(20 * H + 5 * D),
      tk.version,
    ).expect(400);
    expect((res.body as { code: string }).code).toBe('EXTENSION_TOO_LONG');
  });

  it('AC1: hạn mới ≤ hạn cũ → 400 INVALID_RANGE', async () => {
    const m = await newMachine('EX-3');
    const tk = await deliverTo(m, 'mem-x', iso(-1 * H), iso(20 * H));
    const res = await extend(tk.ticketId, iso(10 * H), tk.version).expect(400);
    expect((res.body as { code: string }).code).toBe('INVALID_RANGE');
  });

  it('AC1: đã dùng hết số lần gia hạn → EXTENSION_LIMIT', async () => {
    const m = await newMachine('EX-4');
    const tk = await deliverTo(m, 'mem-x', iso(-1 * H), iso(20 * H));
    await pool.query(`UPDATE ticket SET extension_count=3 WHERE id=$1`, [
      tk.ticketId,
    ]);
    const cur = await pool.query<{ version: number }>(
      `SELECT version FROM ticket WHERE id=$1`,
      [tk.ticketId],
    );
    const res = await extend(
      tk.ticketId,
      iso(20 * H + 1 * D),
      cur.rows[0].version,
    ).expect(409);
    expect((res.body as { code: string }).code).toBe('EXTENSION_LIMIT');
  });

  it('AC4: đã có yêu cầu gia hạn treo → EXTENSION_PENDING', async () => {
    const m = await newMachine('EX-5');
    const tk = await deliverTo(m, 'mem-x', iso(-1 * H), iso(20 * H));
    await extend(tk.ticketId, iso(20 * H + 1 * D), tk.version).expect(201);
    const res = await extend(
      tk.ticketId,
      iso(20 * H + 2 * H),
      tk.version,
    ).expect(409);
    expect((res.body as { code: string }).code).toBe('EXTENSION_PENDING');
  });

  it('AC2: khung mở rộng đè booking người khác → 409 SLOT_TAKEN', async () => {
    const m = await newMachine('EX-6');
    const oldTo = iso(20 * H);
    const tk = await deliverTo(m, 'mem-x', iso(-1 * H), oldTo);
    // booking khác của mem-y chiếm [oldTo+2h, oldTo+1d) trên CÙNG máy
    const ty = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('awaiting_pickup','mem-y','mem-y') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','pending', tstzrange($3,$4,'[)'))`,
      [ty.rows[0].id, m, iso(20 * H + 2 * H), iso(20 * H + 1 * D)],
    );
    const res = await extend(
      tk.ticketId,
      iso(20 * H + 4 * H),
      tk.version,
    ).expect(409);
    expect((res.body as { code: string }).code).toBe('SLOT_TAKEN');
  });

  it('AC1: ticket đã quá hạn → TICKET_OVERDUE', async () => {
    const m = await newMachine('EX-7');
    const tk = await deliverTo(m, 'mem-x', iso(-2 * D), iso(-1 * H));
    await pool.query(`UPDATE ticket SET is_overdue=true WHERE id=$1`, [
      tk.ticketId,
    ]);
    const cur = await pool.query<{ version: number }>(
      `SELECT version FROM ticket WHERE id=$1`,
      [tk.ticketId],
    );
    const res = await extend(
      tk.ticketId,
      iso(1 * H),
      cur.rows[0].version,
    ).expect(409);
    expect((res.body as { code: string }).code).toBe('TICKET_OVERDUE');
  });

  it('AC1 (review MED): hạn cũ đã qua nhưng cờ is_overdue CHƯA bật → vẫn TICKET_OVERDUE (DB now())', async () => {
    const m = await newMachine('EX-10');
    // delivered [−2d, −1h): hạn trả đã trôi qua; KHÔNG set is_overdue (mô phỏng sweep chưa chạy)
    const tk = await deliverTo(m, 'mem-x', iso(-2 * D), iso(-1 * H));
    const res = await extend(tk.ticketId, iso(1 * D), tk.version).expect(409);
    expect((res.body as { code: string }).code).toBe('TICKET_OVERDUE');
  });

  it('AC6: member khác xin gia hạn ticket không phải của mình → 403', async () => {
    const m = await newMachine('EX-8');
    const tk = await deliverTo(m, 'mem-x', iso(-1 * H), iso(20 * H));
    const res = await extend(tk.ticketId, iso(20 * H + 1 * D), tk.version, {
      'x-dev-user-sub': 'mem-y',
      'x-dev-role': 'member',
    }).expect(403);
    expect((res.body as { code: string }).code).toBe('NOT_TICKET_OWNER');
  });

  it('AC5: trả máy khi có extension treo → extension cancelled + result=expired', async () => {
    const m = await newMachine('EX-9');
    const tk = await deliverTo(m, 'mem-x', iso(-1 * H), iso(20 * H));
    const ext = await extend(
      tk.ticketId,
      iso(20 * H + 1 * D),
      tk.version,
    ).expect(201);
    const cur = await pool.query<{ version: number }>(
      `SELECT version FROM ticket WHERE id=$1`,
      [tk.ticketId],
    );
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${tk.ticketId}/return`)
      .set({ 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' })
      .send({ version: cur.rows[0].version, note: 'trả máy ổn' })
      .expect(200);
    const bk = await pool.query<{ state: string; result: string }>(
      `SELECT state, result FROM booking WHERE id=$1`,
      [(ext.body as { id: string }).id],
    );
    expect(bk.rows[0].state).toBe('cancelled');
    expect(bk.rows[0].result).toBe('expired');
  });
});
