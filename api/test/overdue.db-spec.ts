import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { TicketsService } from '../src/modules/tickets/tickets.service';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.8 — cờ quá hạn is_overdue + marker overdue_marked_at (AD-14). Sweep bật/close gỡ.
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[overdue.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[overdue.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const asAdmin = { 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' };

describe('Cờ quá hạn & badge đỏ (story 3.8)', () => {
  let app: INestApplication;
  let pool: Pool;
  let tickets: TicketsService;
  let machine: string;

  /** ticket in_use + booking delivered [from,to) */
  const mkInUse = async (from: string, to: string, m = machine) => {
    const t = await pool.query<{ id: string; version: number }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('in_use','mem-o','mem-o') RETURNING id, version`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','delivered', tstzrange($3,$4,'[)'))`,
      [t.rows[0].id, m, from, to],
    );
    return t.rows[0];
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
    const a = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ('OV-1','laptop',true,'in_use'),('OV-2','laptop',true,'in_use') RETURNING id`,
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

  it('sweep bật cờ ticket in_use quá hạn + overdue_marked_at set (AC 1)', async () => {
    const t = await mkInUse(iso(-5 * H), iso(-1 * H)); // hạn trả 1h trước
    const n = await tickets.markOverdue();
    expect(n).toBeGreaterThanOrEqual(1);
    const tk = await pool.query(
      `SELECT is_overdue, overdue_marked_at FROM ticket WHERE id=$1`,
      [t.id],
    );
    expect(tk.rows[0].is_overdue).toBe(true);
    expect(tk.rows[0].overdue_marked_at).not.toBeNull();
    // AC2: story này KHÔNG phát mail — outbox rỗng sau markOverdue (5.3 mới là chủ mail)
    const ob = await pool.query(`SELECT count(*)::int AS n FROM outbox`);
    expect(ob.rows[0].n).toBe(0);
  });

  it('KHÔNG bật ticket còn hạn (upper period tương lai) (AC 1)', async () => {
    const t = await mkInUse(
      iso(-1 * H),
      iso(3 * H),
      (
        await pool.query<{ id: string }>(
          `SELECT id FROM assets WHERE code='OV-2'`,
        )
      ).rows[0].id,
    );
    await tickets.markOverdue();
    const tk = await pool.query(`SELECT is_overdue FROM ticket WHERE id=$1`, [
      t.id,
    ]);
    expect(tk.rows[0].is_overdue).toBe(false);
  });

  it('idempotent: marker KHÔNG ghi đè lần 2 (AC 1, AD-14)', async () => {
    const t = await mkInUse(
      iso(-8 * H),
      iso(-2 * H),
      (
        await pool.query<{ id: string }>(
          `INSERT INTO assets (code, type, is_pool, status) VALUES ('OV-3','laptop',true,'in_use') RETURNING id`,
        )
      ).rows[0].id,
    );
    await tickets.markOverdue();
    const first = await pool.query(
      `SELECT overdue_marked_at FROM ticket WHERE id=$1`,
      [t.id],
    );
    const marker1 = first.rows[0].overdue_marked_at;
    const n2 = await tickets.markOverdue(); // lần 2: ticket đã is_overdue → không đụng
    const second = await pool.query(
      `SELECT overdue_marked_at FROM ticket WHERE id=$1`,
      [t.id],
    );
    expect(second.rows[0].overdue_marked_at).toEqual(marker1); // marker giữ nguyên
    expect(n2).toBe(0); // không gắn thêm (đã is_overdue)
  });

  it('close (nhận trả) → is_overdue=false, overdue_marked_at GIỮ (FR-42, AC 3)', async () => {
    const m = (
      await pool.query<{ id: string }>(
        `INSERT INTO assets (code, type, is_pool, status) VALUES ('OV-4','laptop',true,'in_use') RETURNING id`,
      )
    ).rows[0].id;
    const t = await mkInUse(iso(-6 * H), iso(-1 * H), m);
    await tickets.markOverdue();
    // Admin nhận trả (3.6) → close
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/return`)
      .set(asAdmin)
      .send({ version: t.version, note: 'nhận muộn' })
      .expect(200);
    const tk = await pool.query(
      `SELECT state, is_overdue, overdue_marked_at FROM ticket WHERE id=$1`,
      [t.id],
    );
    expect(tk.rows[0].state).toBe('closed');
    expect(tk.rows[0].is_overdue).toBe(false); // cờ hết hiệu lực
    expect(tk.rows[0].overdue_marked_at).not.toBeNull(); // marker "từng quá hạn" giữ
  });

  it('awaiting_pickup quá hạn KHÔNG bị mark (chỉ delivered — no-show là 3.9)', async () => {
    const m = (
      await pool.query<{ id: string }>(
        `INSERT INTO assets (code, type, is_pool, status) VALUES ('OV-5','laptop',true,'in_use') RETURNING id`,
      )
    ).rows[0].id;
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('awaiting_pickup','mem-o','mem-o') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','pending', tstzrange($3,$4,'[)'))`,
      [t.rows[0].id, m, iso(-5 * H), iso(-1 * H)],
    );
    await tickets.markOverdue();
    const tk = await pool.query(`SELECT is_overdue FROM ticket WHERE id=$1`, [
      t.rows[0].id,
    ]);
    expect(tk.rows[0].is_overdue).toBe(false);
  });

  it('listOverdue sort thời lượng giảm dần + endpoint admin (AC 1)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/tickets/overdue')
      .set(asAdmin)
      .expect(200);
    const items = res.body as Array<{ overdueMinutes: number }>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    // sort giảm dần
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].overdueMinutes).toBeGreaterThanOrEqual(
        items[i].overdueMinutes,
      );
    }
  });
});
