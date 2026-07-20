import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Đường B — Admin gia hạn THẲNG (đặt hạn trả mới ngay, không qua request/duyệt). */
if (!process.env.DATABASE_URL) {
  throw new Error('[extension-admin.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[extension-admin.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const H = 60 * 60 * 1000;
const D = 24 * H;
const asAdmin = { 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' };

describe('Admin gia hạn thẳng (đường B)', () => {
  let app: INestApplication;
  let pool: Pool;

  const newMachine = async (code: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ($1,'laptop',true,'in_use') RETURNING id`,
      [code],
    );
    return r.rows[0].id;
  };

  // in_use ticket + delivered [from, oldDue). withHeld=true thêm 1 extension held [oldDue, oldDue+1d).
  const setup = async (
    assetId: string,
    from: string,
    oldDue: string,
    opts: { kind?: 'normal' | 'recurring'; withHeld?: boolean } = {},
  ) => {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, kind, borrower_sub, created_by_sub)
       VALUES ('in_use', $1, 'mem-x','mem-x') RETURNING id`,
      [opts.kind ?? 'normal'],
    );
    const d = await pool.query<{ id: string }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1,$2,'normal','delivered', tstzrange($3,$4,'[)')) RETURNING id`,
      [t.rows[0].id, assetId, from, oldDue],
    );
    let heldId: string | null = null;
    if (opts.withHeld) {
      const e = await pool.query<{ id: string }>(
        `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
         VALUES ($1,$2,'extension','held', tstzrange($3,$4,'[)')) RETURNING id`,
        [t.rows[0].id, assetId, oldDue, iso(20 * H + 1 * D)],
      );
      heldId = e.rows[0].id;
    }
    return { ticketId: t.rows[0].id, deliveredId: d.rows[0].id, heldId };
  };

  const extend = (ticketId: string, newDue: string, hdr = asAdmin) =>
    request(app.getHttpServer())
      .post(`/api/admin/tickets/${ticketId}/extend`)
      .set(hdr)
      .send({ newDue });

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
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('mở rộng booking gốc tới hạn mới + extension_count+1', async () => {
    const m = await newMachine('AE-1');
    const oldDue = iso(20 * H);
    const newDue = iso(20 * H + 2 * D);
    const s = await setup(m, iso(-1 * H), oldDue);
    await extend(s.ticketId, newDue).expect(200);
    const d = await pool.query<{ to_ts: string }>(
      `SELECT upper(period) AS to_ts FROM booking WHERE id=$1`,
      [s.deliveredId],
    );
    expect(new Date(d.rows[0].to_ts).getTime()).toBe(
      new Date(newDue).getTime(),
    );
    const tk = await pool.query<{ n: number }>(
      `SELECT extension_count AS n FROM ticket WHERE id=$1`,
      [s.ticketId],
    );
    expect(tk.rows[0].n).toBe(1);
  });

  it('gia hạn được ticket ĐÃ QUÁ HẠN → gỡ is_overdue (gia hạn cứu)', async () => {
    const m = await newMachine('AE-2');
    const s = await setup(m, iso(-2 * D), iso(-1 * H)); // hạn cũ vừa trôi
    await pool.query(`UPDATE ticket SET is_overdue=true WHERE id=$1`, [
      s.ticketId,
    ]);
    await extend(s.ticketId, iso(1 * D)).expect(200);
    const tk = await pool.query<{ is_overdue: boolean }>(
      `SELECT is_overdue FROM ticket WHERE id=$1`,
      [s.ticketId],
    );
    expect(tk.rows[0].is_overdue).toBe(false);
  });

  it('ticket quá hạn: hạn mới VẪN ở quá khứ (sau hạn cũ, trước now) → 400 (audit M6)', async () => {
    const m = await newMachine('AE-M6');
    const s = await setup(m, iso(-3 * D), iso(-2 * H)); // hạn cũ 2h trước
    // newDue 1h trước: > hạn cũ (-2h) NHƯNG vẫn < now → chặn (tránh is_overdue nhấp nháy).
    const res = await extend(s.ticketId, iso(-1 * H)).expect(400);
    expect((res.body as { code: string }).code).toBe('INVALID_RANGE');
  });

  it('hạn mới ≤ hạn hiện tại → 400 INVALID_RANGE', async () => {
    const m = await newMachine('AE-3');
    const oldDue = iso(20 * H);
    const s = await setup(m, iso(-1 * H), oldDue);
    const res = await extend(s.ticketId, iso(10 * H)).expect(400);
    expect((res.body as { code: string }).code).toBe('INVALID_RANGE');
  });

  it('không giới hạn số ngày: nới xa (10 ngày) vẫn 200', async () => {
    const m = await newMachine('AE-4');
    const s = await setup(m, iso(-1 * H), iso(20 * H));
    await extend(s.ticketId, iso(10 * D)).expect(200);
  });

  it('buổi định kỳ → 409 INVALID_STATE', async () => {
    const m = await newMachine('AE-5');
    const s = await setup(m, iso(-1 * H), iso(20 * H), { kind: 'recurring' });
    const res = await extend(s.ticketId, iso(2 * D)).expect(409);
    expect((res.body as { code: string }).code).toBe('INVALID_STATE');
  });

  it('có yêu cầu gia hạn treo → admin áp thẳng hủy nó (expired) + nới booking gốc', async () => {
    const m = await newMachine('AE-6');
    const oldDue = iso(20 * H);
    const newDue = iso(20 * H + 3 * D);
    const s = await setup(m, iso(-1 * H), oldDue, { withHeld: true });
    await extend(s.ticketId, newDue).expect(200);
    const held = await pool.query<{ state: string; result: string | null }>(
      `SELECT state, result FROM booking WHERE id=$1`,
      [s.heldId as string],
    );
    expect(held.rows[0].state).toBe('cancelled');
    expect(held.rows[0].result).toBe('expired');
    const d = await pool.query<{ to_ts: string }>(
      `SELECT upper(period) AS to_ts FROM booking WHERE id=$1`,
      [s.deliveredId],
    );
    expect(new Date(d.rows[0].to_ts).getTime()).toBe(
      new Date(newDue).getTime(),
    );
  });

  it('member gọi → 403 (chỉ admin/sa)', async () => {
    const m = await newMachine('AE-7');
    const s = await setup(m, iso(-1 * H), iso(20 * H));
    await extend(s.ticketId, iso(2 * D), {
      'x-dev-user-sub': 'mem-x',
      'x-dev-role': 'member',
    }).expect(403);
  });
});
