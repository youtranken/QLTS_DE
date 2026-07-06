import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

/** Khóa advisory cố định — 2 instance api cùng khởi động không chạy migration chồng nhau. */
const MIGRATION_LOCK_ID = 727_001;

/** Bắt buộc NNNN_ (zero-pad) — sort chuỗi mới trùng thứ tự số ('10_' < '2_' nếu không pad). */
const MIGRATION_NAME_PATTERN = /^\d{4}_.+\.sql$/;

export interface MigrationLogger {
  log(message: string): void;
}

/**
 * Runner migration raw SQL (AD-12): chạy các file *.sql trong thư mục theo
 * thứ tự tên file, mỗi file một transaction, journal ở bảng _migrations.
 * Idempotent: file đã ghi journal thì bỏ qua — nhưng nội dung file đã apply
 * bị SỬA (checksum lệch) → fail to, không im lặng để schema drift.
 * Convention: file SQL không được chứa BEGIN/COMMIT nội bộ (phá transaction wrapper).
 */
export async function runMigrations(
  pool: Pool,
  dir: string,
  logger: MigrationLogger = console,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const invalid = files.filter((f) => !MIGRATION_NAME_PATTERN.test(f));
  if (invalid.length > 0) {
    throw new Error(
      `Tên migration sai format NNNN_<mô-tả>.sql (bắt buộc zero-pad 4 số): ${invalid.join(', ')}`,
    );
  }
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name text PRIMARY KEY,
         checksum text,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await client.query(
      'ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum text',
    );
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const done = await client.query<{ checksum: string | null }>(
        'SELECT checksum FROM _migrations WHERE name = $1',
        [file],
      );
      if ((done.rowCount ?? 0) > 0) {
        const stored = done.rows[0].checksum;
        if (stored === null) {
          // Backfill journal cũ (trước khi có cột checksum)
          await client.query(
            'UPDATE _migrations SET checksum = $2 WHERE name = $1',
            [file, checksum],
          );
        } else if (stored !== checksum) {
          throw new Error(
            `Migration ${file} đã apply nhưng nội dung file ĐÃ BỊ SỬA (checksum lệch). ` +
              'Không sửa migration đã chạy — tạo migration mới.',
          );
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (name, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file} thất bại: ${(error as Error).message}`,
          {
            cause: error,
          },
        );
      }
      applied.push(file);
      logger.log(`Migration applied: ${file}`);
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
      .catch(() => undefined);
    client.release();
  }
  return applied;
}

/** dist/main.js → dist/migrations (copy qua nest-cli assets); ts-jest/ts-node → src/migrations. */
export function resolveMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? join(__dirname, '..', 'migrations');
}
