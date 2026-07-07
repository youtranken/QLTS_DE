import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.3 — "Request của tôi" + member tự hủy (FR-11, IDOR, optimistic lock).
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[my-requests.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[my-requests.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const A = { 'x-dev-user-sub': 'mem-a', 'x-dev-role': 'member' };

describe('Request của tôi & member tự hủy (story 3.3)', () => {
  let app: INestApplication;
  let pool: Pool;
  let machine: string;

  const mkTicket = async (
    borrower: string,
    state: string,
    assetId: string,
    from: string,
    to: string,
    bookingState: string,
  ) => {
    const t = await pool.query<{ id: string; version: number }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ($1,$2,$2) RETURNING id, version`,
      [state, borrower],
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal',$3, tstzrange($4,$5,'[)'))`,
      [t.rows[0].id, assetId, bookingState, from, to],
    );
    return t.rows[0];
  };

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
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-a','a@t.vn','A','member'),('mem-b','b@t.vn','B','member')`,
    );
    const a = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ('MR-1','laptop',true,'in_use') RETURNING id`,
    );
    machine = a.rows[0].id;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('list CHỈ ticket của mình + nhãn vi + cờ cancellable (AC 1)', async () => {
    await mkTicket(
      'mem-a',
      'awaiting_pickup',
      machine,
      iso(2 * H),
      iso(4 * H),
      'pending',
    );
    await mkTicket(
      'mem-b',
      'awaiting_pickup',
      machine,
      iso(20 * H),
      iso(22 * H),
      'pending',
    );
    const res = await request(app.getHttpServer())
      .get('/api/booking/my-tickets')
      .set(A)
      .expect(200);
    const list = res.body as Array<{
      state: string;
      stateLabel: string;
      assetCode: string;
      cancellable: boolean;
    }>;
    expect(list.length).toBe(1); // chỉ của mem-a
    expect(list[0].stateLabel).toBe('Chờ giao');
    expect(list[0].assetCode).toBe('MR-1');
    expect(list[0].cancellable).toBe(true);
  });

  it('hủy awaiting_pickup TRƯỚC giờ nhận → cancelled + booking nhả khung (AC 2)', async () => {
    const t = await mkTicket(
      'mem-a',
      'awaiting_pickup',
      machine,
      iso(30 * H),
      iso(32 * H),
      'pending',
    );
    await request(app.getHttpServer())
      .post(`/api/booking/my-tickets/${t.id}/cancel`)
      .set(A)
      .send({ version: t.version })
      .expect(200);
    const bk = await pool.query(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [t.id],
    );
    expect(bk.rows[0].state).toBe('cancelled');
    const tk = await pool.query(`SELECT state FROM ticket WHERE id=$1`, [t.id]);
    expect(tk.rows[0].state).toBe('cancelled'); // ticket cũng cancelled (AC 2)
    // khung nhả → availability thấy máy rảnh khung đó
    const av = await request(app.getHttpServer())
      .get('/api/booking/availability')
      .query({ from: iso(30 * H), to: iso(32 * H) })
      .set(A)
      .expect(200);
    expect(
      (av.body as Array<{ code: string }>).some((m) => m.code === 'MR-1'),
    ).toBe(true);
  });

  it('hủy pending_approval bất kỳ lúc (kể cả giờ nhận đã qua) (AC 2)', async () => {
    const t = await mkTicket(
      'mem-a',
      'pending_approval',
      machine,
      iso(-5 * H),
      iso(-3 * H),
      'held',
    );
    await request(app.getHttpServer())
      .post(`/api/booking/my-tickets/${t.id}/cancel`)
      .set(A)
      .send({ version: t.version })
      .expect(200);
  });

  it('awaiting_pickup ĐÃ QUA giờ nhận → 409 CANNOT_CANCEL (AC 3)', async () => {
    const t = await mkTicket(
      'mem-a',
      'awaiting_pickup',
      machine,
      iso(-2 * H),
      iso(-1 * H),
      'pending',
    );
    const res = await request(app.getHttpServer())
      .post(`/api/booking/my-tickets/${t.id}/cancel`)
      .set(A)
      .send({ version: t.version })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('CANNOT_CANCEL');
  });

  it('IDOR: hủy ticket người khác → 403 NOT_TICKET_OWNER (AC 1)', async () => {
    const t = await mkTicket(
      'mem-b',
      'awaiting_pickup',
      machine,
      iso(40 * H),
      iso(42 * H),
      'pending',
    );
    const res = await request(app.getHttpServer())
      .post(`/api/booking/my-tickets/${t.id}/cancel`)
      .set(A)
      .send({ version: t.version })
      .expect(403);
    expect((res.body as { code: string }).code).toBe('NOT_TICKET_OWNER');
  });

  it('version lệch → 409 STALE_VERSION (AC 4)', async () => {
    const t = await mkTicket(
      'mem-a',
      'awaiting_pickup',
      machine,
      iso(50 * H),
      iso(52 * H),
      'pending',
    );
    const res = await request(app.getHttpServer())
      .post(`/api/booking/my-tickets/${t.id}/cancel`)
      .set(A)
      .send({ version: t.version + 99 })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('STALE_VERSION');
  });

  it('in_use (đang mượn) → member KHÔNG hủy được, 409 CANNOT_CANCEL', async () => {
    const t = await mkTicket(
      'mem-a',
      'in_use',
      machine,
      iso(60 * H),
      iso(62 * H),
      'delivered',
    );
    const res = await request(app.getHttpServer())
      .post(`/api/booking/my-tickets/${t.id}/cancel`)
      .set(A)
      .send({ version: t.version })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('CANNOT_CANCEL');
  });

  it('quota giải phóng sau khi hủy: hủy 1 ticket active → submit lại được (AC 2)', async () => {
    // dùng user riêng để không đụng ticket active tích lũy của mem-a
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-q3','q3@t.vn','Q3','member')`,
    );
    const q = { 'x-dev-user-sub': 'mem-q3', 'x-dev-role': 'member' };
    // đặt tới quota (2)
    const s1 = await request(app.getHttpServer())
      .post('/api/booking')
      .set(q)
      .send({ assetId: machine, from: iso(70 * H), to: iso(71 * H) })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(q)
      .send({ assetId: machine, from: iso(72 * H), to: iso(73 * H) })
      .expect(201);
    // ticket thứ 3 → 409 QUOTA
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(q)
      .send({ assetId: machine, from: iso(74 * H), to: iso(75 * H) })
      .expect(409);
    // hủy ticket 1 → quota giải phóng → submit lại 201
    await request(app.getHttpServer())
      .post(`/api/booking/my-tickets/${s1.body.ticketId}/cancel`)
      .set(q)
      .send({ version: 1 })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(q)
      .send({ assetId: machine, from: iso(74 * H), to: iso(75 * H) })
      .expect(201);
  });
});
