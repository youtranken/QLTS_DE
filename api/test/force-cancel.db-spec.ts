import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/**
 * Audit 2026-07-19 (H-2) — hai lớp chống "máy bị giam vĩnh viễn":
 *  1. Trần thời lượng (config max_booking_duration_hours = 2160h/90 ngày) chặn từ gốc.
 *  2. POST admin/tickets/:id/force-cancel — lối thoát khi ticket đã lọt vào trạng thái kẹt.
 * Kịch bản gốc: booking dài đã DUYỆT → autoCloseNoShow chờ hết period, sweep bỏ qua
 * 'pending', member hết quyền hủy sau giờ nhận ⇒ trước bản vá chỉ sửa được bằng SQL tay.
 */
if (!process.env.DATABASE_URL) {
  throw new Error('[force-cancel.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[force-cancel.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const H = 60 * 60 * 1000;
const D = 24 * H;
const asAdmin = { 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' };
const asMember = { 'x-dev-user-sub': 'mem-x', 'x-dev-role': 'member' };

describe('Admin hủy cưỡng chế + trần thời lượng (audit H-2)', () => {
  let app: INestApplication;
  let pool: Pool;

  const newMachine = async (code: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ($1,'laptop',true,'in_use') RETURNING id`,
      [code],
    );
    return r.rows[0].id;
  };

  /** Ticket đã duyệt, đang giữ chỗ tới `to` — đúng trạng thái kẹt của kịch bản gốc. */
  const stuckTicket = async (
    assetId: string,
    from: string,
    to: string,
    kind: 'normal' | 'recurring' = 'normal',
  ) => {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, kind, borrower_sub, created_by_sub)
       VALUES ('awaiting_pickup', $1, 'mem-x','mem-x') RETURNING id`,
      [kind],
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1,$2,'normal','pending', tstzrange($3,$4,'[)'))`,
      [t.rows[0].id, assetId, from, to],
    );
    return t.rows[0].id;
  };

  const forceCancel = (id: string, reason = 'Thu hồi máy gấp', hdr = asAdmin) =>
    request(app.getHttpServer())
      .post(`/api/admin/tickets/${id}/force-cancel`)
      .set(hdr)
      .send({ reason });

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

  it('seed config có trần 2160h (90 ngày)', async () => {
    const r = await pool.query<{ value: string }>(
      `SELECT value FROM config WHERE key='max_booking_duration_hours'`,
    );
    expect(Number(r.rows[0].value)).toBe(2160);
  });

  it('gỡ được ticket kẹt: nhả khung máy + trạng thái cancelled', async () => {
    const m = await newMachine('FC-1');
    const id = await stuckTicket(m, iso(1 * D), iso(400 * D));
    await forceCancel(id).expect(200);

    const t = await pool.query<{ state: string }>(
      `SELECT state FROM ticket WHERE id=$1`,
      [id],
    );
    expect(t.rows[0].state).toBe('cancelled');
    const b = await pool.query<{ state: string }>(
      `SELECT state FROM booking WHERE ticket_id=$1`,
      [id],
    );
    expect(b.rows[0].state).toBe('cancelled');
  });

  it('máy được giải phóng thật — đặt lại đúng khung vừa nhả thì không SLOT_TAKEN', async () => {
    const m = await newMachine('FC-2');
    const from = iso(2 * D);
    const to = iso(3 * D);
    const id = await stuckTicket(m, from, to);
    await forceCancel(id).expect(200);
    // Cùng máy, cùng khung — trước khi hủy sẽ đụng EXCLUDE
    const again = await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       SELECT $1,$2,'normal','pending', tstzrange($3,$4,'[)') RETURNING id`,
      [id, m, from, to],
    );
    expect(again.rowCount).toBe(1);
  });

  it('ghi audit kèm LÝ DO và actor là admin, không phải người mượn', async () => {
    const m = await newMachine('FC-3');
    const id = await stuckTicket(m, iso(1 * D), iso(200 * D));
    await forceCancel(id, 'Máy hỏng cần thu hồi').expect(200);
    const a = await pool.query<{
      actor: string;
      detail: Record<string, string>;
    }>(
      `SELECT actor, detail FROM audit_log WHERE action='tickets.force_cancel' AND object_id=$1`,
      [id],
    );
    expect(a.rowCount).toBe(1);
    expect(a.rows[0].actor).toBe('adm');
    expect(a.rows[0].detail.reason).toBe('Máy hỏng cần thu hồi');
  });

  it('phát outbox báo người mượn, payload mang NGUYÊN VĂN lý do', async () => {
    const m = await newMachine('FC-MAIL');
    const id = await stuckTicket(m, iso(1 * D), iso(10 * D));
    await forceCancel(id, 'Máy cần cho phòng kế toán gấp').expect(200);
    const o = await pool.query<{
      topic: string;
      payload: { ticketId: string; reason: string };
    }>(`SELECT topic, payload FROM outbox WHERE payload->>'ticketId' = $1`, [
      id,
    ]);
    expect(o.rowCount).toBe(1);
    expect(o.rows[0].topic).toBe('ticket_force_cancelled');
    expect(o.rows[0].payload.reason).toBe('Máy cần cho phòng kế toán gấp');
  });

  it('outbox ghi CÙNG transaction — hủy thất bại thì không có mail mồ côi', async () => {
    const m = await newMachine('FC-TX');
    const id = await stuckTicket(m, iso(1 * D), iso(5 * D), 'recurring');
    await forceCancel(id).expect(409); // IS_RECURRING → rollback
    const o = await pool.query(
      `SELECT 1 FROM outbox WHERE payload->>'ticketId' = $1`,
      [id],
    );
    expect(o.rowCount).toBe(0);
  });

  it('thiếu lý do → 400 (quyền đè lên người khác phải có vết)', async () => {
    const m = await newMachine('FC-4');
    const id = await stuckTicket(m, iso(1 * D), iso(5 * D));
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${id}/force-cancel`)
      .set(asAdmin)
      .send({})
      .expect(400);
  });

  it('member gọi → 403 (không tự nâng quyền qua endpoint này)', async () => {
    const m = await newMachine('FC-5');
    const id = await stuckTicket(m, iso(1 * D), iso(5 * D));
    await forceCancel(id, 'thử', asMember).expect(403);
  });

  it('chuỗi định kỳ → IS_RECURRING (giữ bất biến AD-4, không phá deriveParentState)', async () => {
    const m = await newMachine('FC-6');
    const id = await stuckTicket(m, iso(1 * D), iso(5 * D), 'recurring');
    const res = await forceCancel(id).expect(409);
    expect(res.body.code).toBe('IS_RECURRING');
  });

  it('ticket đã kết thúc → CANNOT_CANCEL (không hủy hai lần)', async () => {
    const m = await newMachine('FC-7');
    const id = await stuckTicket(m, iso(1 * D), iso(5 * D));
    await forceCancel(id).expect(200);
    const res = await forceCancel(id).expect(409);
    expect(res.body.code).toBe('CANNOT_CANCEL');
  });

  it('ticket đang mượn (in_use, đã giao) → ALREADY_DELIVERED, KHÔNG hủy (review M1)', async () => {
    // Máy đã giao thật: hủy sẽ nhả booking → double-allocation. Phải đi đường Trả.
    const m = await newMachine('FC-INUSE');
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, kind, borrower_sub, created_by_sub)
       VALUES ('in_use','normal','mem-x','mem-x') RETURNING id`,
    );
    const id = t.rows[0].id;
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1,$2,'normal','delivered', tstzrange($3,$4,'[)'))`,
      [id, m, iso(-1 * D), iso(5 * D)],
    );
    const res = await forceCancel(id).expect(409);
    expect(res.body.code).toBe('ALREADY_DELIVERED');
    // ticket vẫn in_use, booking vẫn delivered (không bị đụng)
    const chk = await pool.query<{ state: string }>(
      `SELECT state FROM ticket WHERE id=$1`,
      [id],
    );
    expect(chk.rows[0].state).toBe('in_use');
  });

  it('ticket không tồn tại → 404', async () => {
    await forceCancel('00000000-0000-0000-0000-000000000000').expect(404);
  });

  // Lớp 1: chặn từ gốc qua HTTP thật — nếu chỉ test hàm thuần sẽ không thấy
  // trường hợp service quên truyền maxDurationHours xuống parseBookingWindow.
  describe('trần thời lượng chặn ngay ở POST /api/booking', () => {
    const submit = (assetId: string, from: string, to: string) =>
      request(app.getHttpServer())
        .post('/api/booking')
        .set(asMember)
        .send({ assetId, from, to });

    it('booking 10 năm → 400 BOOKING_TOO_LONG (kịch bản giam máy bị chặn)', async () => {
      const m = await newMachine('FC-CAP-1');
      const res = await submit(m, iso(1 * H), iso(3650 * D)).expect(400);
      expect(res.body.code).toBe('BOOKING_TOO_LONG');
    });

    it('vượt trần 1 ngày (91 ngày) → 400 BOOKING_TOO_LONG', async () => {
      const m = await newMachine('FC-CAP-2');
      const res = await submit(m, iso(1 * H), iso(1 * H + 91 * D)).expect(400);
      expect(res.body.code).toBe('BOOKING_TOO_LONG');
    });

    it('đúng 90 ngày → KHÔNG bị chặn bởi trần (không phải BOOKING_TOO_LONG)', async () => {
      const m = await newMachine('FC-CAP-3');
      const res = await submit(m, iso(1 * H), iso(1 * H + 90 * D));
      expect(res.body.code).not.toBe('BOOKING_TOO_LONG');
    });
  });
});
