import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.1c — submit đặt mượn ≤48h tự-duyệt + quota + SLOT_TAKEN + form-gate >48h.
 * DB thật qua HTTP stack (AUTH_DEV_MODE). Seed qua pool riêng.
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[tickets.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[tickets.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;

const asMember = { 'x-dev-user-sub': 'mem-tk', 'x-dev-role': 'member' };
const asLongMember = { 'x-dev-user-sub': 'mem-long', 'x-dev-role': 'member' };

describe('Submit đặt mượn ≤48h tự-duyệt (story 3.1c)', () => {
  let app: INestApplication;
  let pool: Pool;
  let machineA: string;
  let machineB: string;
  let lockedM: string;

  const submit = (
    headers: Record<string, string>,
    assetId: string,
    from: string,
    to: string,
  ) =>
    request(app.getHttpServer())
      .post('/api/booking')
      .set(headers)
      .send({ assetId, from, to });

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS outbox, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role, can_long_term) VALUES
         ('mem-tk', 'tk@t.vn', 'Mem Tk', 'member', false),
         ('mem-long', 'long@t.vn', 'Mem Long', 'member', true)`,
    );
    const assets = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES
         ('TK-A', 'laptop', true, 'in_use'),
         ('TK-B', 'laptop', true, 'in_use'),
         ('TK-LOCK', 'laptop', true, 'locked_repair')
       RETURNING id`,
    );
    machineA = assets.rows[0].id;
    machineB = assets.rows[1].id;
    lockedM = assets.rows[2].id;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('≤48h → ticket awaiting_pickup + booking pending + audit system (AC 1)', async () => {
    const res = await submit(asMember, machineA, iso(1 * H), iso(3 * H)).expect(
      201,
    );
    expect(res.body).toMatchObject({
      ticketState: 'awaiting_pickup',
      bookingState: 'pending',
      autoApproved: true,
    });
    const ticket = await pool.query(`SELECT state FROM ticket WHERE id = $1`, [
      res.body.ticketId as string,
    ]);
    expect(ticket.rows[0].state).toBe('awaiting_pickup');
    const audit = await pool.query(
      `SELECT actor, action FROM audit_log WHERE object_id = $1 ORDER BY action`,
      [res.body.ticketId as string],
    );
    const actions = audit.rows.map(
      (r: { actor: string; action: string }) => `${r.action}:${r.actor}`,
    );
    expect(actions).toContain('tickets.auto_approve:system');
    expect(actions).toContain('tickets.create:mem-tk');
  });

  it('quota: ticket active thứ 3 → 409 QUOTA_EXCEEDED (AC 2)', async () => {
    // User RIÊNG, tự dựng state (không mượn side-effect test khác — review 3.1c).
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-quota', 'q@t.vn', 'Q', 'member')`,
    );
    const q = { 'x-dev-user-sub': 'mem-quota', 'x-dev-role': 'member' };
    await submit(q, machineA, iso(40 * H), iso(41 * H)).expect(201);
    await submit(q, machineB, iso(40 * H), iso(41 * H)).expect(201);
    // thứ 3 chạm quota mặc định 2 → 409
    const res = await submit(q, machineA, iso(42 * H), iso(43 * H)).expect(409);
    expect((res.body as { code: string }).code).toBe('QUOTA_EXCEEDED');
  });

  it('race: 2 submit cùng khung cùng máy → 1 thắng, 1 nhận 409 SLOT_TAKEN (AC 3)', async () => {
    // 2 user khác nhau (tránh quota) đặt cùng máy B khung mới
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('race-1', 'r1@t.vn', 'R1', 'member'), ('race-2', 'r2@t.vn', 'R2', 'member')`,
    );
    const at = { 'x-dev-user-sub': 'race-1', 'x-dev-role': 'member' };
    const bt = { 'x-dev-user-sub': 'race-2', 'x-dev-role': 'member' };
    const [r1, r2] = await Promise.all([
      submit(at, machineB, iso(20 * H), iso(22 * H)),
      submit(bt, machineB, iso(20 * H), iso(22 * H)),
    ]);
    const codes = [r1.status, r2.status].sort((a, b) => a - b);
    expect(codes).toEqual([201, 409]);
    const failed = r1.status === 409 ? r1 : r2;
    expect((failed.body as { code: string }).code).toBe('SLOT_TAKEN');
  });

  it('>48h không có quyền dài hạn → 403 LONG_TERM_REQUIRED (AC 4)', async () => {
    const res = await submit(
      asMember,
      machineA,
      iso(1 * H),
      iso(60 * H),
    ).expect(403);
    expect((res.body as { code: string }).code).toBe('LONG_TERM_REQUIRED');
  });

  it('>48h có quyền dài hạn → ticket pending_approval + booking held (AC 4)', async () => {
    const res = await submit(
      asLongMember,
      machineA,
      iso(100 * H),
      iso(160 * H),
    ).expect(201);
    expect(res.body).toMatchObject({
      ticketState: 'pending_approval',
      bookingState: 'held',
      autoApproved: false,
    });
  });

  it('máy đang khóa → 409 ASSET_UNAVAILABLE (AC 3, AD-15)', async () => {
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-lock', 'l@t.vn', 'L', 'member')`,
    );
    const res = await submit(
      { 'x-dev-user-sub': 'mem-lock', 'x-dev-role': 'member' },
      lockedM,
      iso(1 * H),
      iso(3 * H),
    ).expect(409);
    expect((res.body as { code: string }).code).toBe('ASSET_UNAVAILABLE');
  });
});
