import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

/** Khóa advisory cố định — 2 instance api cùng khởi động không chạy migration chồng nhau. */
const MIGRATION_LOCK_ID = 727_001;

export interface MigrationLogger {
  log(message: string): void;
}

/**
 * Runner migration raw SQL (AD-12): chạy các file *.sql trong thư mục theo
 * thứ tự tên file, mỗi file một transaction, journal ở bảng _migrations.
 * Idempotent: file đã ghi journal thì bỏ qua.
 */
export async function runMigrations(
  pool: Pool,
  dir: string,
  logger: MigrationLogger = console,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    for (const file of files) {
      const done = await client.query(
        'SELECT 1 FROM _migrations WHERE name = $1',
        [file],
      );
      if ((done.rowCount ?? 0) > 0) {
        continue;
      }
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [
          file,
        ]);
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
