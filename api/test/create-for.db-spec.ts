import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.7 — Admin tạo request hộ 2 chế độ (FR-12), bỏ quota/quyền, vẫn EXCLUDE.
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[create-for.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[create-for.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const asAdmin = { 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' };

describe('Admin tạo request hộ (story 3.7)', () => {
  let app: INestApplication;
  let pool: Pool;
  let machine: string;
  let lockedM: string;

  const createFor = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/admin/tickets/create-for')
      .set(asAdmin)
      .send(body);

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
         ('mem-b','b@t.vn','Borrower','member'),
         ('adm','a@t.vn','Admin','admin'),
         ('adm2','a2@t.vn','Admin2','admin')`,
    );
    const a = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES
         ('CF-1','laptop',true,'in_use'),
         ('CF-LOCK','laptop',true,'locked_repair')
       RETURNING id`,
    );
    machine = a.rows[0].id;
    lockedM = a.rows[1].id;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('giao ngay → in_use + booking delivered + delivered_at + audit createdBy≠borrower (AC 3)', async () => {
    const res = await createFor({
      borrowerSub: 'mem-b',
      assetId: machine,
      from: iso(0),
      to: iso(3 * H),
      mode: 'now',
    }).expect(201);
    expect(res.body.ticketState).toBe('in_use');
    const tk = await pool.query(
      `SELECT state, delivered_at, borrower_sub, created_by_sub FROM ticket WHERE id=$1`,
      [res.body.ticketId],
    );
    expect(tk.rows[0].state).toBe('in_use');
    expect(tk.rows[0].delivered_at).not.toBeNull();
    expect(tk.rows[0].borrower_sub).toBe('mem-b');
    expect(tk.rows[0].created_by_sub).toBe('adm');
    const bk = await pool.query(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [res.body.ticketId],
    );
    expect(bk.rows[0].state).toBe('delivered');
  });

  it('đặt lịch → awaiting_pickup + booking pending (AC 4)', async () => {
    const res = await createFor({
      borrowerSub: 'mem-b',
      assetId: machine,
      from: iso(100 * H),
      to: iso(102 * H),
      mode: 'schedule',
    }).expect(201);
    expect(res.body.ticketState).toBe('awaiting_pickup');
    const bk = await pool.query(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [res.body.ticketId],
    );
    expect(bk.rows[0].state).toBe('pending');
  });

  it('BỎ quota: borrower đã đầy quota vẫn tạo hộ được (AC 1)', async () => {
    // seed borrower đầy 2 active ticket
    for (let i = 0; i < 2; i++) {
      const t = await pool.query<{ id: string }>(
        `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('awaiting_pickup','mem-b','mem-b') RETURNING id`,
      );
      await pool.query(
        `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','pending', tstzrange($3,$4,'[)'))`,
        [
          t.rows[0].id,
          machine,
          iso((200 + i * 10) * H),
          iso((201 + i * 10) * H),
        ],
      );
    }
    // tạo hộ vẫn OK dù borrower đầy quota
    await createFor({
      borrowerSub: 'mem-b',
      assetId: machine,
      from: iso(300 * H),
      to: iso(301 * H),
      mode: 'schedule',
    }).expect(201);
  });

  it('trùng lịch → 409 SLOT_TAKEN (KHÔNG double-booking — AC 1)', async () => {
    await createFor({
      borrowerSub: 'mem-b',
      assetId: machine,
      from: iso(400 * H),
      to: iso(402 * H),
      mode: 'schedule',
    }).expect(201);
    const res = await createFor({
      borrowerSub: 'mem-b',
      assetId: machine,
      from: iso(401 * H),
      to: iso(403 * H),
      mode: 'schedule',
    }).expect(409);
    expect((res.body as { code: string }).code).toBe('SLOT_TAKEN');
  });

  it('máy khóa → 409 ASSET_UNAVAILABLE (AD-15)', async () => {
    const res = await createFor({
      borrowerSub: 'mem-b',
      assetId: lockedM,
      from: iso(500 * H),
      to: iso(501 * H),
      mode: 'schedule',
    }).expect(409);
    expect((res.body as { code: string }).code).toBe('ASSET_UNAVAILABLE');
  });

  it('borrower không tồn tại → 404 USER_NOT_FOUND', async () => {
    const res = await createFor({
      borrowerSub: 'khong-ton-tai',
      assetId: machine,
      from: iso(600 * H),
      to: iso(601 * H),
      mode: 'schedule',
    }).expect(404);
    expect((res.body as { code: string }).code).toBe('USER_NOT_FOUND');
  });

  it('borrower là admin (không phải member) → 403 BORROWER_NOT_MEMBER', async () => {
    const res = await createFor({
      borrowerSub: 'adm2',
      assetId: machine,
      from: iso(700 * H),
      to: iso(701 * H),
      mode: 'schedule',
    }).expect(403);
    expect((res.body as { code: string }).code).toBe('BORROWER_NOT_MEMBER');
  });

  it('actor==borrower → 403 SELF_CREATE_FORBIDDEN (Admin không tạo hộ cho mình)', async () => {
    // borrowerSub = adm (chính actor)
    const res = await createFor({
      borrowerSub: 'adm',
      assetId: machine,
      from: iso(710 * H),
      to: iso(711 * H),
      mode: 'schedule',
    }).expect(403);
    expect((res.body as { code: string }).code).toBe('SELF_CREATE_FORBIDDEN');
  });

  const newMachine = async (code: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ($1,'laptop',true,'in_use') RETURNING id`,
      [code],
    );
    return r.rows[0].id;
  };

  it('giao ngay kèm note → asset_note handover (AC 3)', async () => {
    const m = await newMachine('CF-N1');
    const res = await createFor({
      borrowerSub: 'mem-b',
      assetId: m,
      from: iso(-1 * H),
      to: iso(2 * H),
      mode: 'now',
      note: 'Giao hộ đầy đủ dây sạc',
    }).expect(201);
    const notes = await pool.query(
      `SELECT note FROM asset_note WHERE asset_id=$1 AND kind='handover' AND note='Giao hộ đầy đủ dây sạc'`,
      [m],
    );
    expect(notes.rowCount).toBe(1);
    expect(res.body.ticketState).toBe('in_use');
  });

  it('photoId ma → 400 FILE_NOT_FOUND, không đổi trạng thái', async () => {
    const m = await newMachine('CF-N2');
    const res = await createFor({
      borrowerSub: 'mem-b',
      assetId: m,
      from: iso(-1 * H),
      to: iso(3 * H),
      mode: 'now',
      photoIds: ['2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f'],
    }).expect(400);
    expect((res.body as { code: string }).code).toBe('FILE_NOT_FOUND');
  });

  it('mode=now KHÔNG cho backdate/future (giờ nhận tương lai) → 400 INVALID_RANGE (Med1)', async () => {
    const res = await createFor({
      borrowerSub: 'mem-b',
      assetId: machine,
      from: iso(800 * H),
      to: iso(802 * H),
      mode: 'now',
    }).expect(400);
    expect((res.body as { code: string }).code).toBe('INVALID_RANGE');
  });

  it('giao ngay (delivered) chiếm chỗ → member khác đặt khung đó → SLOT_TAKEN (AC 1)', async () => {
    const m = await newMachine('CF-N3');
    // tạo hộ giao ngay khung [now-30m, now+90m) → delivered occupying
    await createFor({
      borrowerSub: 'mem-b',
      assetId: m,
      from: iso(-30 * 60 * 1000),
      to: iso(90 * 60 * 1000),
      mode: 'now',
    }).expect(201);
    // member khác submit đặt chồng khung tương lai đó → SLOT_TAKEN
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-c','c@t.vn','C','member')`,
    );
    const res = await request(app.getHttpServer())
      .post('/api/booking')
      .set({ 'x-dev-user-sub': 'mem-c', 'x-dev-role': 'member' })
      .send({ assetId: m, from: iso(30 * 60 * 1000), to: iso(80 * 60 * 1000) })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('SLOT_TAKEN');
  });
});
