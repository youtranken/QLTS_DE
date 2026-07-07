import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.1b — availability máy rảnh trên DB THẬT + qua HTTP stack (AC 1/2/3).
 * Boot app thật (AUTH_DEV_MODE) + seed assets/booking qua pool riêng.
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[booking-availability.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(
    `[booking-availability.db-spec] Từ chối chạy trên '${dbName}'.`,
  );
}

/** giờ tương đối now — availability đòi from ≥ now và trong window */
const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const DAY = 24 * H;

const asMember = { 'x-dev-user-sub': 'mem-av', 'x-dev-role': 'member' };

describe('Availability máy rảnh (story 3.1b)', () => {
  let app: INestApplication;
  let pool: Pool;
  let freeId: string;
  let busyId: string;
  let ticketId: string;

  const getAvail = (from: string, to: string) =>
    request(app.getHttpServer())
      .get('/api/booking/availability')
      .query({ from, to })
      .set(asMember);

  const seedBooking = (
    assetId: string,
    from: string,
    to: string,
    state: string,
  ) =>
    pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1, $2, 'normal', $3, tstzrange($4, $5, '[)'))`,
      [ticketId, assetId, state, from, to],
    );

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
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-av', 'av@t.vn', 'Mem Av', 'member')`,
    );
    const assets = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, configuration, is_pool, status) VALUES
         ('AV-FREE', 'laptop', 'i7/16GB', true, 'in_use'),
         ('AV-BUSY', 'laptop', 'i5/8GB', true, 'in_use'),
         ('AV-LOCKED', 'laptop', 'i5/8GB', true, 'locked_repair'),
         ('AV-NOPOOL', 'laptop', 'i5/8GB', false, 'in_use')
       RETURNING id`,
    );
    freeId = assets.rows[0].id;
    busyId = assets.rows[1].id;
    // software cài trên máy free (hiển thị kèm)
    await pool.query(
      `INSERT INTO assets (code, type, is_pool, status, installed_on_asset_id, license_type, license_name)
       VALUES ('AV-SW', 'software', false, 'in_use', $1, 'perpetual', 'Office')`,
      [freeId],
    );
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub)
       VALUES ('awaiting_pickup', 'mem-av', 'mem-av') RETURNING id`,
    );
    ticketId = t.rows[0].id;
    // AV-BUSY có booking occupying khung [+1h, +3h)
    await seedBooking(busyId, iso(1 * H), iso(3 * H), 'pending');
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('máy pool rảnh hiện kèm cấu hình + software; máy bận ẩn (AC 2)', async () => {
    const res = await getAvail(iso(1 * H), iso(3 * H)).expect(200);
    const codes = (res.body as Array<{ code: string }>).map((m) => m.code);
    expect(codes).toContain('AV-FREE');
    expect(codes).not.toContain('AV-BUSY'); // đang có booking occupying chồng khung
    expect(codes).not.toContain('AV-LOCKED'); // ngoài trạng thái in_use... thực ra locked
    expect(codes).not.toContain('AV-NOPOOL');
    const free = (
      res.body as Array<{
        code: string;
        configuration: string;
        software: unknown[];
      }>
    ).find((m) => m.code === 'AV-FREE');
    expect(free?.configuration).toBe('i7/16GB');
    expect(free?.software).toHaveLength(1);
  });

  it('khung KHÔNG chồng booking bận → máy bận rảnh lại (AC 2)', async () => {
    const res = await getAvail(iso(4 * H), iso(5 * H)).expect(200);
    const codes = (res.body as Array<{ code: string }>).map((m) => m.code);
    expect(codes).toContain('AV-BUSY');
  });

  it('adjacent [) tại điểm nối → KHÔNG coi là bận (AD-2)', async () => {
    // khung [+3h, +4h) kề ngay sau booking [+1h,+3h) → AV-BUSY rảnh
    const res = await getAvail(iso(3 * H), iso(4 * H)).expect(200);
    const codes = (res.body as Array<{ code: string }>).map((m) => m.code);
    expect(codes).toContain('AV-BUSY');
  });

  it('dòng software (is_pool=false) KHÔNG lọt danh sách máy rảnh', async () => {
    const res = await getAvail(iso(1 * H), iso(3 * H)).expect(200);
    const codes = (res.body as Array<{ code: string }>).map((m) => m.code);
    expect(codes).not.toContain('AV-SW');
  });

  it('2 state occupying (held + delivered) đều ẩn máy khỏi availability', async () => {
    const heldAsset = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ('AV-HELD', 'laptop', true, 'in_use') RETURNING id`,
    );
    const delivAsset = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ('AV-DELIV', 'laptop', true, 'in_use') RETURNING id`,
    );
    await seedBooking(heldAsset.rows[0].id, iso(20 * H), iso(22 * H), 'held');
    await seedBooking(
      delivAsset.rows[0].id,
      iso(20 * H),
      iso(22 * H),
      'delivered',
    );
    const res = await getAvail(iso(20 * H), iso(22 * H)).expect(200);
    const codes = (res.body as Array<{ code: string }>).map((m) => m.code);
    expect(codes).not.toContain('AV-HELD');
    expect(codes).not.toContain('AV-DELIV');
  });

  it('booking cancelled/returned KHÔNG ẩn máy (không occupying)', async () => {
    await seedBooking(freeId, iso(10 * H), iso(11 * H), 'cancelled');
    await seedBooking(freeId, iso(10 * H), iso(11 * H), 'returned');
    const res = await getAvail(iso(10 * H), iso(11 * H)).expect(200);
    const codes = (res.body as Array<{ code: string }>).map((m) => m.code);
    expect(codes).toContain('AV-FREE');
  });

  it('service-level 400: to ≤ from → INVALID_RANGE', async () => {
    const res = await getAvail(iso(3 * H), iso(1 * H)).expect(400);
    expect((res.body as { code: string }).code).toBe('INVALID_RANGE');
  });

  it('service-level 400: from quá khứ → PAST_PICKUP', async () => {
    const res = await getAvail(iso(-2 * H), iso(1 * H)).expect(400);
    expect((res.body as { code: string }).code).toBe('PAST_PICKUP');
  });

  it('service-level 400: from ngoài window 30 ngày → BOOKING_WINDOW', async () => {
    const res = await getAvail(iso(31 * DAY), iso(31 * DAY + H)).expect(400);
    expect((res.body as { code: string }).code).toBe('BOOKING_WINDOW');
  });
});
