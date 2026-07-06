import { join } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';

/**
 * Integration test DB THẬT (AC 4, 8) — KHÔNG mock.
 * Cần DATABASE_URL trỏ tới Postgres 18 test (xem README).
 * Chạy: npm run test:db
 */
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

if (!process.env.DATABASE_URL) {
  console.warn(
    '[migrations.db-spec] Bỏ qua: DATABASE_URL chưa đặt — cần Postgres thật để chạy.',
  );
}

describeDb('Migrations + seed config (Postgres thật)', () => {
  const migrationsDir = join(__dirname, '..', 'src', 'migrations');
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    // Đưa DB test về trạng thái chưa-migrate (extension giữ nguyên — CREATE IF NOT EXISTS idempotent)
    await pool.query('DROP TABLE IF EXISTS config, _migrations CASCADE');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('chạy đủ migration theo thứ tự tên file', async () => {
    const applied = await runMigrations(pool, migrationsDir, {
      log: () => undefined,
    });
    expect(applied).toEqual(['0000_btree_gist.sql', '0001_config.sql']);
  });

  it('extension btree_gist đã cài (AD-12)', async () => {
    const res = await pool.query(
      "SELECT extname FROM pg_extension WHERE extname = 'btree_gist'",
    );
    expect(res.rowCount).toBe(1);
  });

  it('bảng config seed đủ 7 tham số FR-44 đúng giá trị mặc định', async () => {
    const res = await pool.query('SELECT key, value FROM config ORDER BY key');
    const byKey = Object.fromEntries(
      res.rows.map((r: { key: string; value: unknown }) => [r.key, r.value]),
    );
    expect(res.rowCount).toBe(7);
    expect(byKey).toEqual({
      booking_window_days: 30,
      active_ticket_quota: 2,
      extension_days_per_grant: 2,
      extension_max_grants: 3,
      license_warning_days: 30,
      working_hours: {
        tz: 'Asia/Ho_Chi_Minh',
        days: [1, 2, 3, 4, 5],
        start: '08:00',
        end: '17:00',
      },
      approval_reminder_working_hours: 4,
    });
  });

  it('idempotent: chạy lại không apply gì, seed không nhân đôi', async () => {
    const appliedAgain = await runMigrations(pool, migrationsDir, {
      log: () => undefined,
    });
    expect(appliedAgain).toEqual([]);
    const res = await pool.query('SELECT count(*)::int AS n FROM config');
    expect(res.rows[0].n).toBe(7);
  });
});
