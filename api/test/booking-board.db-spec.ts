import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 7.4 — read-model bảng "Máy đang mượn" GET /booking/board. */
if (!process.env.DATABASE_URL) {
  throw new Error('[booking-board.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[booking-board.db-spec] Từ chối chạy '${dbName}'.`);
}

const iso = (msFromNow: number) =>
  new Date(Date.now() + msFromNow).toISOString();
const H = 60 * 60 * 1000;
const asCaller = { 'x-dev-user-sub': 'mem-bd', 'x-dev-role': 'member' };

interface BoardRow {
  ticketId: string;
  assetCode: string | null;
  type: string | null;
  borrowerName: string | null;
  from: string | null;
  due: string | null;
  state: string;
  isOverdue: boolean;
  isMine: boolean;
  note: string | null;
  recurringCount: number | null;
}

describe('Borrow board (story 7.4)', () => {
  let app: INestApplication;
  let pool: Pool;
  let assetIds: string[];

  const mkTicket = async (
    state: string,
    borrower: string,
    opts: { kind?: string; overdue?: boolean } = {},
  ) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub, is_overdue)
       VALUES ($1,$2,$3,$3,$4) RETURNING id`,
      [opts.kind ?? 'normal', state, borrower, opts.overdue ?? false],
    );
    return r.rows[0].id;
  };
  const mkBooking = (
    ticketId: string,
    assetId: string,
    state: string,
    fromMs: number,
    toMs: number,
    opts: { note?: string | null; kind?: string } = {},
  ) =>
    pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period, note)
       VALUES ($1,$2,$3,$4, tstzrange($5,$6,'[)'), $7)`,
      [
        ticketId,
        assetId,
        opts.kind ?? 'normal',
        state,
        iso(fromMs),
        iso(toMs),
        opts.note ?? null,
      ],
    );

  const getBoard = () =>
    request(app.getHttpServer())
      .get('/api/booking/board')
      .set(asCaller)
      .expect(200);

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
         ('mem-bd','bd@t.vn','Caller BD','member'),
         ('mem-o','o@t.vn','Other O','member')`,
    );
    const a = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES
         ('BD-1','laptop',true,'in_use'),
         ('BD-2','laptop',true,'in_use'),
         ('BD-3','desktop',true,'in_use'),
         ('BD-4','laptop',true,'in_use'),
         ('BD-5','laptop',true,'in_use'),
         ('BD-6','laptop',true,'in_use')
       RETURNING id`,
    );
    assetIds = a.rows.map((r) => r.id);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('trả in_use toàn hệ + vé caller; ẩn vé người khác chưa giao, ẩn đã trả/đóng', async () => {
    // 1: in_use other, note, due +5h
    const t1 = await mkTicket('in_use', 'mem-o');
    await mkBooking(t1, assetIds[0], 'delivered', -1 * H, 5 * H, {
      note: 'Ghi chú 1',
    });
    // 2: in_use other OVERDUE, due -1h
    const t2 = await mkTicket('in_use', 'mem-o', { overdue: true });
    await mkBooking(t2, assetIds[1], 'delivered', -10 * H, -1 * H);
    // 3: in_use other, due +20h
    const t3 = await mkTicket('in_use', 'mem-o');
    await mkBooking(t3, assetIds[2], 'delivered', -1 * H, 20 * H);
    // 4: awaiting_pickup CALLER (pending), due +30h → thấy; có note của CHÍNH caller
    const t4 = await mkTicket('awaiting_pickup', 'mem-bd');
    await mkBooking(t4, assetIds[3], 'pending', 28 * H, 30 * H, {
      note: 'Ghi chú của tôi',
    });
    // 5: awaiting_pickup OTHER (pending) → KHÔNG thấy
    const t5 = await mkTicket('awaiting_pickup', 'mem-o');
    await mkBooking(t5, assetIds[4], 'pending', 28 * H, 30 * H);
    // 6: closed → KHÔNG thấy
    const t6 = await mkTicket('closed', 'mem-o');
    await mkBooking(t6, assetIds[5], 'returned', -20 * H, -10 * H);
    // 8: pending_approval CALLER (held) → thấy
    const t8 = await mkTicket('pending_approval', 'mem-bd');
    await mkBooking(t8, assetIds[0], 'held', 40 * H, 90 * H);
    // 9: pending_approval OTHER (held) → KHÔNG thấy (chốt AD-5 nhánh held)
    const t9 = await mkTicket('pending_approval', 'mem-o');
    await mkBooking(t9, assetIds[4], 'held', 40 * H, 90 * H);

    const res = await getBoard();
    const rows = res.body as BoardRow[];
    const ids = rows.map((r) => r.ticketId);
    expect(ids).toEqual(expect.arrayContaining([t1, t2, t3, t4, t8]));
    expect(ids).not.toContain(t5);
    expect(ids).not.toContain(t6);
    expect(ids).not.toContain(t9);

    const r1 = rows.find((r) => r.ticketId === t1)!;
    expect(r1.borrowerName).toBe('Other O');
    expect(r1.isMine).toBe(false);
    // Note của người khác KHÔNG public trên board — chỉ chủ vé thấy (P0 3.1, AD-5)
    expect(r1.note).toBeNull();
    const r4 = rows.find((r) => r.ticketId === t4)!;
    expect(r4.isMine).toBe(true);
    expect(r4.note).toBe('Ghi chú của tôi'); // chủ vé VẪN thấy note của mình

    // AD-5: không lộ sub/email
    for (const r of rows) {
      expect(r).not.toHaveProperty('borrowerSub');
      expect(r).not.toHaveProperty('sub');
      expect(r).not.toHaveProperty('email');
    }
  });

  it('sắp xếp: quá hạn → in_use sắp đến hạn → in_use xa → chờ nhận', async () => {
    const res = await getBoard();
    const rows = res.body as BoardRow[];
    // dòng đầu = overdue
    expect(rows[0].isOverdue).toBe(true);
    // awaiting_pickup nằm sau mọi in_use
    const firstAwaitingIdx = rows.findIndex(
      (r) => r.state === 'awaiting_pickup',
    );
    const lastInUseIdx = rows.map((r) => r.state).lastIndexOf('in_use');
    expect(firstAwaitingIdx).toBeGreaterThan(lastInUseIdx);
    // trong in_use: due tăng dần (bỏ overdue đầu)
    const inUseDue = rows
      .filter((r) => r.state === 'in_use')
      .map((r) => (r.due ? new Date(r.due).getTime() : 0));
    const sorted = [...inUseDue].sort((a, b) => a - b);
    expect(inUseDue).toEqual(sorted);
  });

  it('recurringCount: set cho recurring, null cho normal', async () => {
    await pool.query('DELETE FROM booking');
    await pool.query('DELETE FROM ticket');
    const tr = await mkTicket('in_use', 'mem-bd', { kind: 'recurring' });
    await mkBooking(tr, assetIds[0], 'delivered', -1 * H, 3 * H, {
      kind: 'recurring',
    });
    await mkBooking(tr, assetIds[1], 'held', 24 * H, 27 * H, {
      kind: 'recurring',
    });
    await mkBooking(tr, assetIds[2], 'held', 48 * H, 51 * H, {
      kind: 'recurring',
    });
    const tn = await mkTicket('in_use', 'mem-bd');
    await mkBooking(tn, assetIds[3], 'delivered', -1 * H, 4 * H);

    const rows = (await getBoard()).body as BoardRow[];
    // recurring in_use: mỗi buổi delivered = 1 dòng; ở đây 1 buổi delivered → 1 dòng, count=3 buổi
    const rr = rows.find((r) => r.ticketId === tr)!;
    const rn = rows.find((r) => r.ticketId === tn)!;
    expect(rr.recurringCount).toBe(3);
    expect(rn.recurringCount).toBeNull();
  });
});
