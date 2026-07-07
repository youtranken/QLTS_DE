import { join } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import {
  BOOKING_STATES,
  OCCUPYING_STATES,
} from '../src/modules/tickets/ticket-states';

/**
 * Story 3.1a — nền DB booking trên Postgres THẬT (AD-2/AD-15/AD-12).
 * File db-spec MỚI cho cluster booking/tickets (quy ước epic 2: không chèn vào assets.db-spec).
 * Test ở đây INSERT thẳng SQL — chứng minh tầng DB tự vệ BẤT KỂ app viết gì.
 */
if (!process.env.DATABASE_URL) {
  throw new Error(
    '[booking.db-spec] DATABASE_URL chưa đặt — cần Postgres thật.',
  );
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[booking.db-spec] Từ chối chạy trên DB '${dbName}'.`);
}

/** Giờ VN cố định cho test — period là tstzrange UTC, bound [) */
const T = (h: number, m = 0) =>
  new Date(Date.UTC(2026, 7, 10, h, m)).toISOString();

describe('Nền DB booking — double-booking bất khả thi (story 3.1a)', () => {
  let pool: Pool;
  let poolMachine: string;
  let lockedMachine: string;
  let nonPoolMachine: string;
  let freeMachine: string;
  let racyMachine: string;
  let ticketId: string;

  const insertBooking = (
    assetId: string,
    from: string,
    to: string,
    state = 'pending',
  ) =>
    pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
       VALUES ($1, $2, 'normal', $3, tstzrange($4, $5, '[)')) RETURNING id`,
      [ticketId, assetId, state, from, to],
    );

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES ('member-bk', 'bk@t.vn', 'Member Booking', 'member')`,
    );
    const assets = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, status, is_pool) VALUES
         ('BK-POOL-01', 'laptop', 'in_use', true),
         ('BK-LOCKED-01', 'laptop', 'locked_repair', true),
         ('BK-NOPOOL-01', 'laptop', 'in_use', false),
         ('BK-FREE-01', 'laptop', 'in_use', true),
         ('BK-RACY-01', 'laptop', 'in_use', true)
       RETURNING id`,
    );
    [poolMachine, lockedMachine, nonPoolMachine, freeMachine, racyMachine] =
      assets.rows.map((r) => r.id);
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (state, borrower_sub, created_by_sub)
       VALUES ('awaiting_pickup', 'member-bk', 'member-bk') RETURNING id`,
    );
    ticketId = t.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('OCCUPYING_STATES TS khớp function DB booking_state_occupies từng state (AC 1 — một nguồn)', async () => {
    for (const state of BOOKING_STATES) {
      const res = await pool.query<{ occ: boolean }>(
        'SELECT booking_state_occupies($1) AS occ',
        [state],
      );
      expect({ state, occ: res.rows[0].occ }).toEqual({
        state,
        occ: (OCCUPYING_STATES as readonly string[]).includes(state),
      });
    }
  });

  it('2 INSERT chồng giờ cùng máy → cái sau bị DB từ chối 23P01 (AC 5)', async () => {
    await insertBooking(poolMachine, T(3), T(5)); // 10:00–12:00 VN
    await expect(insertBooking(poolMachine, T(4), T(6))).rejects.toMatchObject({
      code: '23P01',
    });
  });

  it('2 range chạm nhau tại điểm nối [) → KHÔNG coi là chồng (AC 5, AD-2)', async () => {
    // Cặp adjacent ĐỘC LẬP (không dựa test trước): 14:00–16:00 kề 16:00–18:00
    await expect(insertBooking(poolMachine, T(7), T(9))).resolves.toBeDefined();
    await expect(
      insertBooking(poolMachine, T(9), T(11)),
    ).resolves.toBeDefined();
  });

  it('CHECK ép bound [): range [] / (] / biên vô hạn đều bị từ chối 23514 (F6)', async () => {
    const badRange = (expr: string) =>
      pool.query(
        `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
         VALUES ($1, $2, 'normal', 'pending', ${expr})`,
        [ticketId, poolMachine],
      );
    await expect(
      badRange(`tstzrange('${T(20)}', '${T(21)}', '[]')`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      badRange(`tstzrange('${T(20)}', '${T(21)}', '(]')`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      badRange(`tstzrange(NULL, '${T(21)}', '[)')`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      badRange(`tstzrange('${T(20)}', NULL, '[)')`),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('booking cancelled/returned chồng giờ → KHÔNG chặn (không occupying)', async () => {
    await expect(
      insertBooking(poolMachine, T(3), T(6), 'cancelled'),
    ).resolves.toBeDefined();
    await expect(
      insertBooking(poolMachine, T(3), T(6), 'returned'),
    ).resolves.toBeDefined();
  });

  it('INSERT range rỗng → CHECK từ chối 23514 (AC 5)', async () => {
    await expect(insertBooking(poolMachine, T(8), T(8))).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('INSERT lên máy đang khóa → trigger AD-15 từ chối ASSET_UNAVAILABLE (AC 5)', async () => {
    await expect(
      insertBooking(lockedMachine, T(3), T(5)),
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('ASSET_UNAVAILABLE') as string,
    });
  });

  it('INSERT lên máy ngoài pool → trigger AD-15 từ chối (AC 5)', async () => {
    await expect(
      insertBooking(nonPoolMachine, T(3), T(5)),
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('ASSET_UNAVAILABLE') as string,
    });
  });

  it('UPDATE booking đổi state cancelled→held trên máy đang khóa → trigger AD-15 chặn (F1)', async () => {
    // Bằng chứng trigger phủ cả UPDATE, không chỉ INSERT.
    const b = await insertBooking(freeMachine, T(30), T(31), 'cancelled');
    const bookingId = b.rows[0].id as string;
    await pool.query(
      `UPDATE assets SET status = 'locked_repair' WHERE id = $1`,
      [freeMachine],
    );
    try {
      await expect(
        pool.query(`UPDATE booking SET state = 'held' WHERE id = $1`, [
          bookingId,
        ]),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('ASSET_UNAVAILABLE') as string,
      });
      // Ngược lại: HỦY booking trên máy khóa (→ cancelled, non-occupying) PHẢI được (không kẹt)
      await expect(
        pool.query(`UPDATE booking SET version = version + 1 WHERE id = $1`, [
          bookingId,
        ]),
      ).resolves.toBeDefined();
    } finally {
      await pool.query(`UPDATE assets SET status = 'in_use' WHERE id = $1`, [
        freeMachine,
      ]);
    }
  });

  it('UPDATE booking dời asset_id sang máy ngoài pool → trigger AD-15 chặn (F1)', async () => {
    const b = await insertBooking(freeMachine, T(32), T(33), 'held');
    const bookingId = b.rows[0].id as string;
    await expect(
      pool.query(`UPDATE booking SET asset_id = $1 WHERE id = $2`, [
        nonPoolMachine,
        bookingId,
      ]),
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('ASSET_UNAVAILABLE') as string,
    });
  });

  it('race AD-15: INSERT booking BLOCK ở FOR SHARE trong lúc tx khóa máy chưa commit (F8)', async () => {
    // Chốt chặt: assert INSERT còn PENDING trước khi tx1 commit — chứng minh FOR SHARE
    // thật sự serialize, không phải "đọc status sau commit". Bỏ FOR SHARE → test này đỏ.
    const tx1 = await pool.connect();
    const tx2 = await pool.connect();
    try {
      await tx1.query('BEGIN');
      await tx1.query(
        `UPDATE assets SET status = 'locked_repair', version = version + 1 WHERE id = $1`,
        [racyMachine],
      );
      let settled = false;
      const insertPromise = tx2
        .query(
          `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
           VALUES ($1, $2, 'normal', 'pending', tstzrange($3, $4, '[)'))`,
          [ticketId, racyMachine, T(40), T(41)],
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((r) => setTimeout(r, 200));
      // INSERT phải còn treo (bị chặn bởi row lock của tx1) — chưa được quyết
      expect(settled).toBe(false);
      await tx1.query('COMMIT');
      await expect(insertPromise).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('ASSET_UNAVAILABLE') as string,
      });
    } finally {
      await pool.query(`UPDATE assets SET status = 'in_use' WHERE id = $1`, [
        racyMachine,
      ]);
      tx1.release();
      tx2.release();
    }
  });
});
