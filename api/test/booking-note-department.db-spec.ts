import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 7.2 — booking.note (member submit). */
if (!process.env.DATABASE_URL) {
  throw new Error('[booking-note-department.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(
    `[booking-note-department.db-spec] Từ chối chạy '${dbName}'.`,
  );
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const asMember = { 'x-dev-user-sub': 'mem-nd', 'x-dev-role': 'member' };

describe('Booking note (story 7.2)', () => {
  let app: INestApplication;
  let pool: Pool;
  let machine: string;

  const submit = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/api/booking').set(asMember).send(body);

  const bookingOf = (ticketId: string) =>
    pool.query<{ note: string | null }>(
      `SELECT note FROM booking WHERE ticket_id=$1`,
      [ticketId],
    );

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES
         ('mem-nd','m@t.vn','Member ND','member'),
         ('adm-nd','a@t.vn','Admin ND','admin')`,
    );
    const a = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status)
       VALUES ('ND-1','laptop',true,'in_use') RETURNING id`,
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

  it('AC2 — member submit với note → lưu đúng', async () => {
    const res = await submit({
      assetId: machine,
      from: iso(1 * H),
      to: iso(2 * H),
      note: 'Mượn họp',
    }).expect(201);
    const bk = await bookingOf(res.body.ticketId);
    expect(bk.rows[0].note).toBe('Mượn họp');
  });

  it('AC2 — note toàn khoảng trắng → lưu NULL', async () => {
    const res = await submit({
      assetId: machine,
      from: iso(7 * H),
      to: iso(8 * H),
      note: '   ',
    }).expect(201);
    const bk = await bookingOf(res.body.ticketId);
    expect(bk.rows[0].note).toBeNull();
  });

  it('AC2 — note > 500 ký tự → 400 validation (khóa MaxLength)', async () => {
    await submit({
      assetId: machine,
      from: iso(15 * H),
      to: iso(16 * H),
      note: 'x'.repeat(501),
    }).expect(400);
  });

  it('AC4 — submit không note → NULL, luồng cũ OK', async () => {
    const res = await submit({
      assetId: machine,
      from: iso(9 * H),
      to: iso(10 * H),
    }).expect(201);
    const bk = await bookingOf(res.body.ticketId);
    expect(bk.rows[0].note).toBeNull();
  });
});
