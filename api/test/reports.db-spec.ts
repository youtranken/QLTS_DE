import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import { ReportsService } from '../src/modules/reports/reports.service';
import { deriveParentState } from '../src/modules/tickets/derive-parent-state';

/** Story 6.1 — báo cáo mượn (theo máy/người) + tỉ lệ quá hạn theo tháng. Chỉ cần Postgres. */
if (!process.env.DATABASE_URL) {
  throw new Error('[reports.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[reports.db-spec] Từ chối chạy trên '${dbName}'.`);
}

describe('Reports (story 6.1)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let reports: ReportsService;

  const insertUser = (sub: string, fullName: string | null = null) =>
    pool.query(
      `INSERT INTO users (sub, full_name, role, status) VALUES ($1,$2,'member','active')`,
      [sub, fullName],
    );

  const insertAsset = async (code: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, status, is_pool) VALUES ($1,'laptop','in_use',true) RETURNING id`,
      [code],
    );
    return r.rows[0].id;
  };

  const insertTicket = async (
    state: string,
    borrower: string,
    kind = 'normal',
  ) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub) VALUES ($1,$2,$3,$3) RETURNING id`,
      [kind, state, borrower],
    );
    return r.rows[0].id;
  };

  const insertBooking = (
    ticketId: string,
    assetId: string,
    kind: string,
    state: string,
    lowerIso: string,
    upperIso: string,
  ) =>
    pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1,$2,$3,$4, tstzrange($5::timestamptz, $6::timestamptz, '[)'))`,
      [ticketId, assetId, kind, state, lowerIso, upperIso],
    );

  /** Ticket ĐÃ đóng với marker báo cáo (closed_at bắt buộc, overdue/no_show tùy chọn). */
  const insertClosed = (
    borrower: string,
    closedAtIso: string,
    opts: { overdue?: boolean; noShow?: boolean; kind?: string } = {},
  ) =>
    pool.query(
      `INSERT INTO ticket (kind, state, close_reason, borrower_sub, created_by_sub, overdue_marked_at, closed_at)
       VALUES ($1,'closed',$2,$3,$3,$4,$5)`,
      [
        opts.kind ?? 'normal',
        opts.noShow ? 'no_show' : null,
        borrower,
        opts.overdue ? closedAtIso : null,
        closedAtIso,
      ],
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS processed_webhook_events, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    db = drizzle(pool);
    reports = new ReportsService(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM booking');
    await pool.query('DELETE FROM ticket');
    await pool.query('DELETE FROM assets');
    await pool.query('DELETE FROM users');
  });

  it('AC1 — tần suất theo máy: chỉ đếm booking normal/recurring TỪNG delivered (delivered/returned)', async () => {
    await insertUser('u1', 'An');
    const t = await insertTicket('in_use', 'u1');
    const tr = await insertTicket('in_use', 'u1', 'recurring');
    const a1 = await insertAsset('A1');
    const a2 = await insertAsset('A2');
    const a3 = await insertAsset('A3');

    // a1: delivered + returned (đếm 2); cancelled + extension (không đếm)
    await insertBooking(
      t,
      a1,
      'normal',
      'delivered',
      '2026-05-10T01:00:00Z',
      '2026-05-10T03:00:00Z',
    );
    await insertBooking(
      t,
      a1,
      'normal',
      'returned',
      '2026-05-11T01:00:00Z',
      '2026-05-11T03:00:00Z',
    );
    await insertBooking(
      t,
      a1,
      'normal',
      'cancelled',
      '2026-05-12T01:00:00Z',
      '2026-05-12T03:00:00Z',
    );
    await insertBooking(
      t,
      a1,
      'extension',
      'returned',
      '2026-05-13T01:00:00Z',
      '2026-05-13T03:00:00Z',
    );

    // a2: 4 buổi recurring delivered/returned = 4 lượt
    await insertBooking(
      tr,
      a2,
      'recurring',
      'delivered',
      '2026-05-12T01:00:00Z',
      '2026-05-12T03:00:00Z',
    );
    await insertBooking(
      tr,
      a2,
      'recurring',
      'delivered',
      '2026-05-13T01:00:00Z',
      '2026-05-13T03:00:00Z',
    );
    await insertBooking(
      tr,
      a2,
      'recurring',
      'returned',
      '2026-05-14T01:00:00Z',
      '2026-05-14T03:00:00Z',
    );
    await insertBooking(
      tr,
      a2,
      'recurring',
      'returned',
      '2026-05-15T01:00:00Z',
      '2026-05-15T03:00:00Z',
    );

    // a3: chỉ cancelled + extension → không xuất hiện
    await insertBooking(
      t,
      a3,
      'normal',
      'cancelled',
      '2026-05-16T01:00:00Z',
      '2026-05-16T03:00:00Z',
    );
    await insertBooking(
      t,
      a3,
      'extension',
      'returned',
      '2026-05-17T01:00:00Z',
      '2026-05-17T03:00:00Z',
    );

    const res = await reports.borrowByAsset('2026-05-01', '2026-05-31', 1, 20);
    expect(res.total).toBe(2);
    expect(res.items.map((r) => [r.code, r.count])).toEqual([
      ['A2', 4],
      ['A1', 2],
    ]);
  });

  it('AC1 — ngoài kỳ không tính', async () => {
    await insertUser('u1');
    const t = await insertTicket('in_use', 'u1');
    const a1 = await insertAsset('A1');
    await insertBooking(
      t,
      a1,
      'normal',
      'delivered',
      '2026-04-30T01:00:00Z',
      '2026-04-30T03:00:00Z',
    );
    const res = await reports.borrowByAsset('2026-05-01', '2026-05-31', 1, 20);
    expect(res.items).toEqual([]);
  });

  it('AC2 — tần suất theo người: đếm ticket close, loại no_show, recurring đếm 1', async () => {
    await insertUser('u1', 'An');
    await insertUser('u2', 'Binh');
    await insertClosed('u1', '2026-05-10T03:00:00Z');
    await insertClosed('u1', '2026-05-11T03:00:00Z');
    await insertClosed('u1', '2026-05-12T03:00:00Z', { noShow: true }); // loại
    await insertClosed('u2', '2026-05-13T03:00:00Z', { kind: 'recurring' }); // đếm 1

    const res = await reports.borrowByUser('2026-05-01', '2026-05-31', 1, 20);
    expect(res.total).toBe(2);
    expect(res.items.map((r) => [r.fullName, r.count])).toEqual([
      ['An', 2],
      ['Binh', 1],
    ]);
  });

  it('AC3 — tỉ lệ quá hạn theo tháng: marker bất biến, loại no_show cả tử lẫn mẫu, ranh giới VN', async () => {
    await insertUser('u1');
    // Tháng 3 VN: ticket close 05:00 sáng 01/03 VN (= 28/02 22:00 UTC) — phải rơi vào THÁNG 3
    await insertClosed('u1', '2026-02-28T22:00:00Z', { overdue: true }); // VN 2026-03-01, quá hạn
    await insertClosed('u1', '2026-03-15T03:00:00Z'); // không quá hạn
    await insertClosed('u1', '2026-03-20T03:00:00Z'); // không quá hạn
    await insertClosed('u1', '2026-03-10T03:00:00Z', {
      overdue: true,
      noShow: true,
    }); // loại cả 2
    // Tháng 4: không có ticket close

    const res = await reports.overdueRatio('2026-03-01', '2026-04-30');
    expect(res.map((r) => r.month)).toEqual(['2026-03', '2026-04']);
    const mar = res.find((r) => r.month === '2026-03')!;
    expect([mar.total, mar.overdue]).toEqual([3, 1]);
    expect(mar.ratio).toBeCloseTo(1 / 3, 5);
    const apr = res.find((r) => r.month === '2026-04')!;
    expect([apr.total, apr.overdue, apr.ratio]).toEqual([0, 0, null]);
  });

  it('AC3 — kỳ vượt 24 tháng bị từ chối', async () => {
    await expect(
      reports.overdueRatio('2020-01-01', '2026-01-01'),
    ).rejects.toThrow(/24 tháng/);
  });

  it('AC4 — closed_at ghi MỘT LẦN (COALESCE), update sau không đổi', async () => {
    await insertUser('u1');
    const t = await insertTicket('in_use', 'u1');
    const close = async () =>
      pool.query<{ closed_at: string }>(
        `UPDATE ticket SET state='closed', closed_at = COALESCE(closed_at, now()),
           version = version + 1 WHERE id = $1 RETURNING closed_at`,
        [t],
      );
    const first = (await close()).rows[0].closed_at;
    await new Promise((r) => setTimeout(r, 20));
    const second = (await close()).rows[0].closed_at;
    expect(second).toEqual(first);
    expect(first).not.toBeNull();
  });

  it('AC4 — deriveParentState (code thật) set closed_at khi cha định kỳ → closed', async () => {
    await insertUser('u1');
    const parent = await insertTicket('in_use', 'u1', 'recurring');
    const a1 = await insertAsset('A1');
    // Mọi buổi terminal & có returned → derive ra state 'closed' (bảng chân trị AD-4)
    await insertBooking(
      parent,
      a1,
      'recurring',
      'returned',
      '2026-05-10T01:00:00Z',
      '2026-05-10T03:00:00Z',
    );
    await deriveParentState(db, parent);
    const r = await pool.query<{ state: string; closed_at: string | null }>(
      `SELECT state, closed_at FROM ticket WHERE id = $1`,
      [parent],
    );
    expect(r.rows[0].state).toBe('closed');
    expect(r.rows[0].closed_at).not.toBeNull();
    // Chạy lại derive → closed_at KHÔNG đổi (COALESCE giữ lần đầu)
    const first = r.rows[0].closed_at;
    await deriveParentState(db, parent);
    const r2 = await pool.query<{ closed_at: string }>(
      `SELECT closed_at FROM ticket WHERE id = $1`,
      [parent],
    );
    expect(r2.rows[0].closed_at).toEqual(first);
  });
});
