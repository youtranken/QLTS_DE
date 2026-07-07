import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/**
 * Story 3.6 — giao/nhận máy (FR-14/17), tab Mượn-trả, ảnh kiểm quyền (NFR-8).
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[handover.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[handover.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const asAdmin = { 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' };
const asOwner = { 'x-dev-user-sub': 'mem-o', 'x-dev-role': 'member' };
const asOther = { 'x-dev-user-sub': 'mem-x', 'x-dev-role': 'member' };
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('anh gia lap'),
]);

describe('Giao máy & nhận trả (story 3.6)', () => {
  let app: INestApplication;
  let pool: Pool;
  let machine: string;
  let storageDir: string;

  const mkTicket = async (
    state: string,
    from: string,
    to: string,
    bkState: string,
  ) => {
    const t = await pool.query<{ id: string; version: number }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ($1,'mem-o','mem-o') RETURNING id, version`,
      [state],
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal',$3, tstzrange($4,$5,'[)'))`,
      [t.rows[0].id, machine, bkState, from, to],
    );
    return t.rows[0];
  };

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    storageDir = mkdtempSync(join(tmpdir(), 'qlts-ho-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-o','o@t.vn','Owner','member'),('mem-x','x@t.vn','Other','member')`,
    );
    const a = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ('HO-1','laptop',true,'in_use') RETURNING id`,
    );
    machine = a.rows[0].id;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(storageDir, { recursive: true, force: true });
    delete process.env.AUTH_DEV_MODE;
    delete process.env.FILE_STORAGE_DIR;
  });

  it('giao → in_use + booking delivered + delivered_at (AC 1)', async () => {
    const t = await mkTicket(
      'awaiting_pickup',
      iso(1 * H),
      iso(3 * H),
      'pending',
    );
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/deliver`)
      .set(asAdmin)
      .send({ version: t.version })
      .expect(200);
    const tk = await pool.query(
      `SELECT state, delivered_at FROM ticket WHERE id=$1`,
      [t.id],
    );
    const bk = await pool.query(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [t.id],
    );
    expect(tk.rows[0].state).toBe('in_use');
    expect(tk.rows[0].delivered_at).not.toBeNull();
    expect(bk.rows[0].state).toBe('delivered');
  });

  it('nhận (note bắt buộc) → closed + booking returned + returned_at + asset_note handover (AC 2)', async () => {
    const t = await mkTicket('in_use', iso(20 * H), iso(22 * H), 'delivered');
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/return`)
      .set(asAdmin)
      .send({ version: t.version, note: 'Máy trầy nhẹ góc phải' })
      .expect(200);
    const tk = await pool.query(
      `SELECT state, returned_at FROM ticket WHERE id=$1`,
      [t.id],
    );
    const bk = await pool.query(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [t.id],
    );
    expect(tk.rows[0].state).toBe('closed');
    expect(tk.rows[0].returned_at).not.toBeNull();
    expect(bk.rows[0].state).toBe('returned');
    const notes = await pool.query(
      `SELECT kind, note FROM asset_note WHERE asset_id=$1 AND kind='handover'`,
      [machine],
    );
    expect(
      notes.rows.some(
        (r: { note: string }) => r.note === 'Máy trầy nhẹ góc phải',
      ),
    ).toBe(true);
  });

  it('nhận thiếu note → 400 (AC 2)', async () => {
    const t = await mkTicket('in_use', iso(30 * H), iso(32 * H), 'delivered');
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/return`)
      .set(asAdmin)
      .send({ version: t.version })
      .expect(400);
  });

  it('giao ticket không phải awaiting_pickup → 409 INVALID_STATE (AC 1)', async () => {
    const t = await mkTicket('in_use', iso(40 * H), iso(42 * H), 'delivered');
    const res = await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/deliver`)
      .set(asAdmin)
      .send({ version: t.version })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('INVALID_STATE');
  });

  it('member → 403 deliver/return (AC 4)', async () => {
    const t = await mkTicket(
      'awaiting_pickup',
      iso(50 * H),
      iso(52 * H),
      'pending',
    );
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/deliver`)
      .set(asOwner)
      .send({ version: t.version })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/return`)
      .set(asOwner)
      .send({ version: t.version, note: 'x' })
      .expect(403);
  });

  it('ảnh: chủ ticket xem được, member khác 403, admin xem được (AC 5)', async () => {
    // upload ảnh qua /admin/files
    const up = await request(app.getHttpServer())
      .post('/api/admin/files')
      .set(asAdmin)
      .field('kind', 'image')
      .attach('file', PNG, 'giao.png')
      .expect(201);
    const fileId = up.body.id as string;
    // giao kèm ảnh
    const t = await mkTicket(
      'awaiting_pickup',
      iso(60 * H),
      iso(62 * H),
      'pending',
    );
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/deliver`)
      .set(asAdmin)
      .send({ version: t.version, photoIds: [fileId] })
      .expect(200);
    // chủ xem được
    await request(app.getHttpServer())
      .get(`/api/booking/tickets/${t.id}/photos/${fileId}`)
      .set(asOwner)
      .expect(200);
    // member khác → 403
    await request(app.getHttpServer())
      .get(`/api/booking/tickets/${t.id}/photos/${fileId}`)
      .set(asOther)
      .expect(403);
    // admin xem được
    await request(app.getHttpServer())
      .get(`/api/booking/tickets/${t.id}/photos/${fileId}`)
      .set(asAdmin)
      .expect(200);
  });

  it('ảnh không thuộc ticket → 404 (chống đọc file id bất kỳ, AC 5)', async () => {
    const t = await mkTicket(
      'awaiting_pickup',
      iso(70 * H),
      iso(72 * H),
      'pending',
    );
    await request(app.getHttpServer())
      .get(
        `/api/booking/tickets/${t.id}/photos/2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f`,
      )
      .set(asOwner)
      .expect(404);
  });

  it('photoId ma (không tồn tại) → 400 FILE_NOT_FOUND, không 500, không đổi trạng thái (Bug1)', async () => {
    const t = await mkTicket(
      'awaiting_pickup',
      iso(80 * H),
      iso(82 * H),
      'pending',
    );
    const res = await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/deliver`)
      .set(asAdmin)
      .send({
        version: t.version,
        photoIds: ['2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f'],
      })
      .expect(400);
    expect((res.body as { code: string }).code).toBe('FILE_NOT_FOUND');
    // ticket KHÔNG bị đổi trạng thái (rollback sạch)
    const tk = await pool.query(`SELECT state FROM ticket WHERE id=$1`, [t.id]);
    expect(tk.rows[0].state).toBe('awaiting_pickup');
  });

  it('deliver version lệch → 409 STALE_VERSION (AC 1)', async () => {
    const t = await mkTicket(
      'awaiting_pickup',
      iso(90 * H),
      iso(92 * H),
      'pending',
    );
    const res = await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/deliver`)
      .set(asAdmin)
      .send({ version: t.version + 99 })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('STALE_VERSION');
  });

  it('deliver kèm note optional → note vào asset_note handover (AC 1)', async () => {
    const t = await mkTicket(
      'awaiting_pickup',
      iso(100 * H),
      iso(102 * H),
      'pending',
    );
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t.id}/deliver`)
      .set(asAdmin)
      .send({ version: t.version, note: 'Giao máy đầy đủ phụ kiện' })
      .expect(200);
    const notes = await pool.query(
      `SELECT note FROM asset_note WHERE asset_id=$1 AND kind='handover' AND note='Giao máy đầy đủ phụ kiện'`,
      [machine],
    );
    expect(notes.rowCount).toBe(1);
  });

  it('quota giải phóng sau return (closed ∉ active) (AC 2)', async () => {
    // user riêng đầy quota bằng 2 active (1 in_use để return); return → còn 1 → submit lọt
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('mem-rq','rq@t.vn','RQ','member')`,
    );
    const t1 = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('in_use','mem-rq','mem-rq') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','delivered', tstzrange($3,$4,'[)'))`,
      [t1.rows[0].id, machine, iso(200 * H), iso(202 * H)],
    );
    await pool.query(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('awaiting_pickup','mem-rq','mem-rq')`,
    );
    const rq = { 'x-dev-user-sub': 'mem-rq', 'x-dev-role': 'member' };
    // đầy quota 2 → submit thứ 3 chặn
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(rq)
      .send({ assetId: machine, from: iso(300 * H), to: iso(301 * H) })
      .expect(409);
    // Admin return t1 → closed → còn 1 active
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${t1.rows[0].id}/return`)
      .set(asAdmin)
      .send({ version: 1, note: 'ok' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(rq)
      .send({ assetId: machine, from: iso(300 * H), to: iso(301 * H) })
      .expect(201);
  });

  it('tab Mượn-trả: list ticket của máy + delivered/returned + trạng thái (AC 3)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/admin/tickets/by-asset/${machine}/handovers`)
      .set(asAdmin)
      .expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const items = res.body.items as Array<{
      borrowerName: string;
      stateLabel: string;
      deliveredAt: string | null;
    }>;
    // có lượt của Owner + có trạng thái Đã đóng (từ test return); không lẫn cancelled
    expect(items.some((i) => i.borrowerName === 'Owner')).toBe(true);
    expect(items.some((i) => i.stateLabel === 'Đã đóng')).toBe(true);
  });
});
