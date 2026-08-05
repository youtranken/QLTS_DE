import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 4.2 — Admin duyệt/từ chối gia hạn (AD-3 thứ tự tx, FR-47/49). */
if (!process.env.DATABASE_URL) {
  throw new Error('[extension-approve.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[extension-approve.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const H = 60 * 60 * 1000;
const D = 24 * H;
const asAdmin = { 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' };

describe('Admin duyệt/từ chối gia hạn (story 4.2)', () => {
  let app: INestApplication;
  let pool: Pool;

  const newMachine = async (code: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ($1,'laptop',true,'in_use') RETURNING id`,
      [code],
    );
    return r.rows[0].id;
  };

  // in_use ticket + delivered [from, oldDue) + extension held [oldDue, newDue)
  const setup = async (
    assetId: string,
    from: string,
    oldDue: string,
    newDue: string,
  ) => {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub) VALUES ('in_use','mem-x','mem-x') RETURNING id`,
    );
    const d = await pool.query<{ id: string }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'normal','delivered', tstzrange($3,$4,'[)')) RETURNING id`,
      [t.rows[0].id, assetId, from, oldDue],
    );
    const e = await pool.query<{ id: string; version: number }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES ($1,$2,'extension','held', tstzrange($3,$4,'[)')) RETURNING id, version`,
      [t.rows[0].id, assetId, oldDue, newDue],
    );
    return {
      ticketId: t.rows[0].id,
      deliveredId: d.rows[0].id,
      extId: e.rows[0].id,
      extVersion: e.rows[0].version,
    };
  };

  const approve = (extId: string, version: number, hdr = asAdmin) =>
    request(app.getHttpServer())
      .post(`/api/admin/tickets/extensions/${extId}/approve`)
      .set(hdr)
      .send({ version });

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

  it('AC2 (AD-3 order): duyệt → booking gốc mở rộng tới hạn mới + extension cancelled/approved + count+1', async () => {
    const m = await newMachine('AP-1');
    const oldDue = iso(20 * H);
    const newDue = iso(20 * H + 1 * D);
    const s = await setup(m, iso(-1 * H), oldDue, newDue);
    await approve(s.extId, s.extVersion).expect(200);
    // extension → cancelled + approved (test này FAIL nếu đảo thứ tự 2a/2b: EXCLUDE 23P01)
    const ex = await pool.query<{ state: string; result: string }>(
      `SELECT state, result FROM booking WHERE id=$1`,
      [s.extId],
    );
    expect(ex.rows[0].state).toBe('cancelled');
    expect(ex.rows[0].result).toBe('approved');
    // booking gốc mở rộng: upper(period) == newDue
    const d = await pool.query<{ to_ts: string }>(
      `SELECT upper(period) AS to_ts FROM booking WHERE id=$1`,
      [s.deliveredId],
    );
    expect(new Date(d.rows[0].to_ts).getTime()).toBe(
      new Date(newDue).getTime(),
    );
    // extension_count +1
    const tk = await pool.query<{ n: number }>(
      `SELECT extension_count AS n FROM ticket WHERE id=$1`,
      [s.ticketId],
    );
    expect(tk.rows[0].n).toBe(1);
  });

  it('duyệt gia hạn → reset due_notified_at (hạn mới phát lại mail tới hạn)', async () => {
    const m = await newMachine('AP-DN');
    const s = await setup(m, iso(-1 * H), iso(20 * H), iso(20 * H + 1 * D));
    await pool.query(`UPDATE booking SET due_notified_at = now() WHERE id=$1`, [
      s.deliveredId,
    ]);
    await approve(s.extId, s.extVersion).expect(200);
    const d = await pool.query<{ dn: string | null }>(
      `SELECT due_notified_at AS dn FROM booking WHERE id=$1`,
      [s.deliveredId],
    );
    expect(d.rows[0].dn).toBeNull();
  });

  it('AC2: duyệt ticket đang quá hạn → gỡ is_overdue, GIỮ overdue_marked_at (AD-14)', async () => {
    const m = await newMachine('AP-2');
    const oldDue = iso(-1 * H); // hạn cũ vừa trôi
    const newDue = iso(1 * D); // hạn mới tương lai
    const s = await setup(m, iso(-2 * D), oldDue, newDue);
    await pool.query(
      `UPDATE ticket SET is_overdue=true, overdue_marked_at=now()-interval '1 hour' WHERE id=$1`,
      [s.ticketId],
    );
    await approve(s.extId, s.extVersion).expect(200);
    const tk = await pool.query<{ is_overdue: boolean; marked: string | null }>(
      `SELECT is_overdue, overdue_marked_at AS marked FROM ticket WHERE id=$1`,
      [s.ticketId],
    );
    expect(tk.rows[0].is_overdue).toBe(false); // gỡ cờ
    expect(tk.rows[0].marked).not.toBeNull(); // marker giữ (FR-42)
  });

  it('AC4: hạn mới đã ở quá khứ → EXTENSION_EXPIRED', async () => {
    const m = await newMachine('AP-3');
    const s = await setup(m, iso(-3 * D), iso(-2 * D), iso(-1 * H)); // new_due đã qua
    const res = await approve(s.extId, s.extVersion).expect(409);
    expect((res.body as { code: string }).code).toBe('EXTENSION_EXPIRED');
  });

  it('AC4: version lệch → STALE_VERSION', async () => {
    const m = await newMachine('AP-4');
    const s = await setup(m, iso(-1 * H), iso(20 * H), iso(20 * H + 1 * D));
    const res = await approve(s.extId, s.extVersion + 9).expect(409);
    expect((res.body as { code: string }).code).toBe('STALE_VERSION');
  });

  it('AC3: từ chối → extension cancelled/result=rejected, period booking gốc KHÔNG đổi', async () => {
    const m = await newMachine('AP-5');
    const oldDue = iso(20 * H);
    const s = await setup(m, iso(-1 * H), oldDue, iso(20 * H + 1 * D));
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/extensions/${s.extId}/reject`)
      .set(asAdmin)
      .send({ version: s.extVersion, reason: 'Máy cần bảo trì' })
      .expect(200);
    const ex = await pool.query<{ state: string; result: string }>(
      `SELECT state, result FROM booking WHERE id=$1`,
      [s.extId],
    );
    expect(ex.rows[0].state).toBe('cancelled');
    expect(ex.rows[0].result).toBe('rejected');
    // booking gốc giữ nguyên upper = oldDue
    const d = await pool.query<{ to_ts: string }>(
      `SELECT upper(period) AS to_ts FROM booking WHERE id=$1`,
      [s.deliveredId],
    );
    expect(new Date(d.rows[0].to_ts).getTime()).toBe(
      new Date(oldDue).getTime(),
    );
  });

  it('AC1: member gọi duyệt gia hạn → 403 (chỉ admin/sa)', async () => {
    const m = await newMachine('AP-6');
    const s = await setup(m, iso(-1 * H), iso(20 * H), iso(20 * H + 1 * D));
    await approve(s.extId, s.extVersion, {
      'x-dev-user-sub': 'mem-x',
      'x-dev-role': 'member',
    }).expect(403);
  });

  // 9.10: ticket đang mượn có yêu cầu gia hạn (extension held) — queue /in-use chỉ 1 dòng,
  // KHÔNG nhân đôi (trước đây JOIN OCCUPYING_STATES khớp cả delivered lẫn extension held).
  it('9.10: đang mượn + gia hạn treo → queue in-use hiện ĐÚNG 1 dòng', async () => {
    const m = await newMachine('DEDUP-1');
    const oldDue = iso(20 * H);
    const s = await setup(m, iso(-1 * H), oldDue, iso(20 * H + 1 * D));
    const res = await request(app.getHttpServer())
      .get('/api/admin/tickets/in-use')
      .set(asAdmin)
      .expect(200);
    const mine = (res.body as Array<{ id: string; to: string }>).filter(
      (r) => r.id === s.ticketId,
    );
    expect(mine).toHaveLength(1);
    // dòng còn lại phải là booking mượn (delivered) tới HẠN CŨ, không phải khung gia hạn
    expect(new Date(mine[0].to).getTime()).toBe(new Date(oldDue).getTime());
  });
});
