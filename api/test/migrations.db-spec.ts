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
    await pool.query(
      'DROP TABLE IF EXISTS catalog, department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('chạy đủ migration theo thứ tự tên file', async () => {
    const applied = await runMigrations(pool, migrationsDir, {
      log: () => undefined,
    });
    expect(applied).toEqual([
      '0000_btree_gist.sql',
      '0001_config.sql',
      '0002_users.sql',
      '0003_audit_log.sql',
      '0004_sessions.sql',
      '0005_audit_append_only.sql',
      '0006_audit_no_truncate.sql',
      '0007_users_role_check.sql',
      '0008_user_permissions.sql',
      '0009_assets.sql',
      '0010_allocation_history.sql',
      '0011_allocation_history_append_only.sql',
      '0012_assets_software.sql',
      '0013_asset_note.sql',
      '0014_asset_note_append_only.sql',
      '0015_files_inventory.sql',
      '0016_assets_import.sql',
      '0017_ticket_booking.sql',
      '0018_booking_bookability_trigger.sql',
      '0019_outbox.sql',
      '0020_ticket_handover.sql',
      '0021_pickup_reminder.sql',
      '0022_outbox_redrive.sql',
      '0023_ticket_extension_count.sql',
      '0024_approval_reminder.sql',
      '0025_overdue_reminder.sql',
      '0026_offboarding.sql',
      '0027_ticket_closed_at.sql',
      '0028_session_id_token.sql',
      '0029_department.sql',
      '0030_booking_note_department.sql',
      '0031_catalog.sql',
      '0032_sessions_local_sa.sql',
      '0033_software_code_nullable.sql',
      '0034_catalog_resync_orphan_types.sql',
      '0035_catalog_add_place.sql',
      '0036_assets_lock_eta.sql',
      '0037_drop_department.sql',
      '0038_assets_purged_at.sql',
      '0039_config_working_hours_auto_approve.sql',
    ]);
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

  it('bảng config seed đủ 9 tham số FR-44 đúng giá trị mặc định', async () => {
    const res = await pool.query('SELECT key, value FROM config ORDER BY key');
    const byKey = Object.fromEntries(
      res.rows.map((r: { key: string; value: unknown }) => [r.key, r.value]),
    );
    expect(res.rowCount).toBe(9);
    expect(byKey).toEqual({
      booking_window_days: 30,
      active_ticket_quota: 2,
      extension_days_per_grant: 2,
      extension_max_grants: 3,
      license_warning_days: 30,
      // 0039 (audit H3): giờ làm 07:00–18:00, T2–T7 (days 1..6)
      working_hours: {
        tz: 'Asia/Ho_Chi_Minh',
        days: [1, 2, 3, 4, 5, 6],
        start: '07:00',
        end: '18:00',
      },
      approval_reminder_working_hours: 4,
      // 5.5: lịch sync danh bạ định kỳ (0026)
      directory_sync_interval_minutes: 60,
      // 0039 (audit H2): ngưỡng auto-duyệt (giờ) — SA chỉnh được
      auto_approve_max_hours: 48,
    });
  });

  it('idempotent: chạy lại không apply gì, seed không nhân đôi', async () => {
    const appliedAgain = await runMigrations(pool, migrationsDir, {
      log: () => undefined,
    });
    expect(appliedAgain).toEqual([]);
    const res = await pool.query('SELECT count(*)::int AS n FROM config');
    expect(res.rows[0].n).toBe(9);
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
