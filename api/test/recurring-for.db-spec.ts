import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 7.5 — admin đặt chuỗi định kỳ HỘ member (POST /admin/tickets/recurring-for). */
if (!process.env.DATABASE_URL) {
  throw new Error('[recurring-for.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[recurring-for.db-spec] Từ chối chạy '${dbName}'.`);
}

/** Buổi ngày +n (VN cùng ngày): 02:00–04:00 UTC = 09:00–11:00 VN. */
const sess = (n: number, startH = 2, endH = 4) => {
  const base = new Date(Date.now() + n * 86400000);
  const [y, mo, da] = [
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
  ];
  return {
    from: new Date(Date.UTC(y, mo, da, startH, 0)).toISOString(),
    to: new Date(Date.UTC(y, mo, da, endH, 0)).toISOString(),
  };
};
const asAdmin = { 'x-dev-user-sub': 'adm-rf', 'x-dev-role': 'admin' };

describe('Recurring create-for (story 7.5)', () => {
  let app: INestApplication;
  let pool: Pool;
  let machine: string;

  const post = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/admin/tickets/recurring-for')
      .set(asAdmin)
      .send(body);

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    // member KHÔNG can_recurring + sẽ đầy quota — vẫn phải tạo hộ được
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role, can_recurring) VALUES
         ('mem-rf','m@t.vn','Member RF','member',false),
         ('adm-rf','a@t.vn','Admin RF','admin',false)`,
    );
    const a = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status)
       VALUES ('RF-1','laptop',true,'in_use') RETURNING id`,
    );
    machine = a.rows[0].id;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM booking');
    await pool.query('DELETE FROM ticket');
  });

  it('AC6 — bỏ quota/quyền: 2 buổi khác tuần → ticket awaiting_pickup, buổi pending', async () => {
    // seed borrower đầy quota (2 ticket active) → vẫn tạo hộ được
    for (let i = 0; i < 2; i++) {
      await pool.query(
        `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('awaiting_pickup','mem-rf','mem-rf')`,
      );
    }
    const res = await post({
      borrowerSub: 'mem-rf',
      assetId: machine,
      sessions: [sess(3), sess(11)],
    }).expect(201);
    expect(res.body.count).toBe(2);
    const tk = await pool.query<{ state: string; kind: string }>(
      `SELECT state, kind FROM ticket WHERE id=$1`,
      [res.body.ticketId],
    );
    expect(tk.rows[0]).toMatchObject({
      state: 'awaiting_pickup',
      kind: 'recurring',
    });
    const bk = await pool.query<{ state: string }>(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [res.body.ticketId],
    );
    expect(bk.rows).toHaveLength(2);
    expect(bk.rows.every((r) => r.state === 'pending')).toBe(true);
  });

  it('AC6 — borrower = actor → 403 SELF_CREATE_FORBIDDEN', async () => {
    const res = await post({
      borrowerSub: 'adm-rf',
      assetId: machine,
      sessions: [sess(3)],
    }).expect(403);
    expect(res.body.code).toBe('SELF_CREATE_FORBIDDEN');
  });

  it('AC6 — 2 buổi cùng tuần → 400 RECUR_WEEK_DUP', async () => {
    const res = await post({
      borrowerSub: 'mem-rf',
      assetId: machine,
      sessions: [sess(3, 2, 4), sess(3, 6, 8)],
    }).expect(400);
    expect(res.body.code).toBe('RECUR_WEEK_DUP');
  });
});
