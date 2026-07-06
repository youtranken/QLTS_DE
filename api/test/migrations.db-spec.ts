import { join } from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';

/**
 * Integration test DB THẬT (AC 4, 8) — KHÔNG mock.
 * Cần DATABASE_URL trỏ tới Postgres 18 TEST (tên DB phải chứa "test" — có DROP TABLE).
 * Chạy: npm run test:db
 */
if (!process.env.DATABASE_URL) {
  // Fail-fast: không skip im lặng — CI quên set biến sẽ thấy đỏ, không "xanh giả"
  throw new Error(
    '[migrations.db-spec] DATABASE_URL chưa đặt — test DB bắt buộc Postgres thật (xem README).',
  );
}

const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(
    `[migrations.db-spec] Từ chối chạy: DB '${dbName}' không chứa 'test' — test này DROP TABLE config/_migrations.`,
  );
}

describe('Migrations + seed config (Postgres thật)', () => {
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

  it('journal ghi checksum cho mọi migration đã apply', async () => {
    const res = await pool.query(
      'SELECT count(*)::int AS n FROM _migrations WHERE checksum IS NULL',
    );
    expect(res.rows[0].n).toBe(0);
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

  it('migration đã apply bị sửa nội dung (checksum lệch) → fail to, không im lặng', async () => {
    await pool.query(
      "UPDATE _migrations SET checksum = 'gia-mao' WHERE name = '0001_config.sql'",
    );
    await expect(
      runMigrations(pool, migrationsDir, { log: () => undefined }),
    ).rejects.toThrow(/checksum lệch/);
  });
});
