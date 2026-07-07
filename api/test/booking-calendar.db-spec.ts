import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.2 — lịch máy calendar (FR-10, AD-5 không lộ người mượn). DB thật qua HTTP.
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[booking-calendar.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[booking-calendar.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const H = 60 * 60 * 1000;

const asMember = { 'x-dev-user-sub': 'mem-cal', 'x-dev-role': 'member' };

describe('Lịch máy calendar (story 3.2)', () => {
  let app: INestApplication;
  let pool: Pool;
  let machine: string;
  let ticketId: string;
  let mondayVN: Date; // Thứ 2 00:00 VN của tuần đích (60 ngày tới)

  const cal = (assetId: string, weekStart?: string) =>
    request(app.getHttpServer())
      .get(`/api/booking/machines/${assetId}/calendar`)
      .query(weekStart ? { weekStart } : {})
      .set(asMember);

  /** offset giờ tính từ Thứ 2 00:00 VN của tuần đích → tstzrange nằm chắc trong tuần */
  const wk = (h: number) => new Date(mondayVN.getTime() + h * H).toISOString();

  const seed = (from: string, to: string, state: string, kind = 'normal') =>
    pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1, $2, $3, $4, tstzrange($5, $6, '[)'))`,
      [ticketId, machine, kind, state, from, to],
    );

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-cal', 'c@t.vn', 'C', 'member')`,
    );
    const a = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ('CAL-1', 'laptop', true, 'in_use') RETURNING id`,
    );
    machine = a.rows[0].id;
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('awaiting_pickup', 'mem-cal', 'mem-cal') RETURNING id`,
    );
    ticketId = t.rows[0].id;
    // Neo tuần đích = Thứ 2 của tuần chứa (now + 60 ngày) — CÙNG công thức service (date_trunc week VN)
    const m = await pool.query<{ ws: string }>(
      `SELECT (date_trunc('week', (now() + interval '60 days') AT TIME ZONE 'Asia/Ho_Chi_Minh')
               AT TIME ZONE 'Asia/Ho_Chi_Minh') AS ws`,
    );
    mondayVN = new Date(m.rows[0].ws);
    // 3 khối occupying NẰM CHẮC trong tuần đích (2-4h, 26-28h, 50-52h < 168h); + 2 non-occupying chồng
    await seed(wk(2), wk(4), 'held');
    await seed(wk(26), wk(28), 'pending');
    await seed(wk(50), wk(52), 'delivered');
    await seed(wk(2), wk(3), 'cancelled');
    await seed(wk(5), wk(6), 'returned');
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('held + pending + delivered đều thành busy; cancelled/returned KHÔNG (AC 1)', async () => {
    const res = await cal(machine, wk(1)).expect(200);
    const busy = res.body.busy as Array<{
      from: string;
      to: string;
      kind: string;
    }>;
    expect(busy.length).toBe(3);
  });

  it('AD-5: payload KHÔNG có borrower/user_id/lý do (AC 3)', async () => {
    const res = await cal(machine, wk(1)).expect(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/mem-cal/);
    expect(raw).not.toMatch(/borrower/i);
    const busy = res.body.busy as Array<Record<string, unknown>>;
    for (const b of busy) {
      expect(Object.keys(b).sort()).toEqual(['from', 'kind', 'to']);
    }
  });

  it('tuần khác (1 tuần sau tuần đích) KHÔNG dính booking tuần đích (AC 1/2)', async () => {
    const res = await cal(machine, wk(24 * 8)).expect(200); // +8 ngày = tuần kế
    expect((res.body.busy as unknown[]).length).toBe(0);
  });

  it('booking vắt ranh giới tuần hiện ở CẢ hai tuần (AC 1)', async () => {
    // booking [wk(160), wk(180)) — wk(168)=đầu tuần kế → vắt ranh giới
    await seed(wk(160), wk(180), 'held');
    const thisWeek = await cal(machine, wk(1)).expect(200);
    const nextWeek = await cal(machine, wk(24 * 8)).expect(200);
    const inThis = (thisWeek.body.busy as Array<{ from: string }>).some(
      (b) => new Date(b.from).getTime() === new Date(wk(160)).getTime(),
    );
    const inNext = (nextWeek.body.busy as Array<{ from: string }>).some(
      (b) => new Date(b.from).getTime() === new Date(wk(160)).getTime(),
    );
    expect(inThis).toBe(true);
    expect(inNext).toBe(true);
  });

  it('weekStart=null → tuần chứa hiện tại (busy rỗng vì booking ở +60 ngày)', async () => {
    const res = await cal(machine).expect(200);
    expect((res.body.busy as unknown[]).length).toBe(0);
    const ws = new Date(res.body.weekStart as string);
    const vnDay = new Date(ws.getTime() + 7 * H).getUTCDay();
    expect(vnDay).toBe(1); // vẫn là Thứ 2 giờ VN
  });

  it('máy không tồn tại → 404 ASSET_NOT_FOUND (AC 4)', async () => {
    const res = await cal('2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f').expect(404);
    expect((res.body as { code: string }).code).toBe('ASSET_NOT_FOUND');
  });

  it('weekStart chuẩn hóa về Thứ 2 giờ VN bất kể instant trong tuần (AC 2)', async () => {
    // Query bằng một mốc GIỮA tuần (thứ 4) → vẫn ra Thứ 2 của tuần đó
    const res = await cal(machine, wk(48)).expect(200);
    const ws = new Date(res.body.weekStart as string);
    const vnDay = new Date(ws.getTime() + 7 * H).getUTCDay(); // 1 = Monday
    expect(vnDay).toBe(1);
    expect(ws.getTime()).toBe(mondayVN.getTime());
  });
});
