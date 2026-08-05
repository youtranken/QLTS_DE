import {
  Controller,
  Get,
  HttpException,
  INestApplication,
  Param,
} from '@nestjs/common';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { Audited } from '../src/modules/audit/audited.decorator';
import { Public } from '../src/modules/auth/public.decorator';
import { createTestApp } from './test-app.helper';

if (!process.env.DATABASE_URL) {
  throw new Error('[audit.db-spec] DATABASE_URL chưa đặt — cần Postgres thật.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[audit.db-spec] Từ chối chạy trên DB '${dbName}'.`);
}

/** Controller test: route auditable thành công + route auditable luôn lỗi. */
@Public()
@Controller('test-audited')
class AuditedTestController {
  @Get(':id')
  @Audited('test.action', 'thing')
  ok(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Get('fail/always')
  @Audited('test.should_not_log', 'thing')
  fail(): never {
    throw new HttpException('nổ có chủ đích', 400);
  }
}

describe('Nền audit append-only (story 1.4)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    delete process.env.AUTH_DEV_MODE;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    app = await createTestApp([AuditedTestController]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('trigger DB chặn UPDATE trên audit_log (AC 1)', async () => {
    await pool.query(
      "INSERT INTO audit_log (actor, action) VALUES ('t', 'seed.row')",
    );
    await expect(
      pool.query("UPDATE audit_log SET action = 'sua-lich-su'"),
    ).rejects.toThrow(/append-only/);
  });

  it('trigger DB chặn DELETE trên audit_log (AC 1)', async () => {
    await expect(pool.query('DELETE FROM audit_log')).rejects.toThrow(
      /append-only/,
    );
  });

  it('INSERT vẫn hoạt động bình thường', async () => {
    await expect(
      pool.query(
        "INSERT INTO audit_log (actor, action) VALUES ('t2', 'seed.row2')",
      ),
    ).resolves.toBeDefined();
  });

  it('trigger DB chặn TRUNCATE trên audit_log (review 1.4)', async () => {
    await expect(pool.query('TRUNCATE audit_log')).rejects.toThrow(
      /append-only/,
    );
  });

  // Migration 0040 (audit 2026-07-19): allocation_history + asset_note cũng phải chặn
  // TRUNCATE như audit_log — trước 0040 chỉ có trigger FOR EACH ROW (không kích hoạt
  // khi TRUNCATE). Không có test này, refactor forbid_*_mutation() có thể tháo bảo vệ
  // mà suite vẫn xanh (review L2).
  it('trigger DB chặn TRUNCATE trên allocation_history + asset_note (0040)', async () => {
    await expect(pool.query('TRUNCATE allocation_history')).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query('TRUNCATE asset_note')).rejects.toThrow(
      /append-only/,
    );
  });

  it('@Audited: handler thành công → 1 dòng audit đúng action/objectId, actor system khi không đăng nhập (AC 3)', async () => {
    // interceptor AWAIT ghi xong mới trả response — không cần sleep
    await request(app.getHttpServer())
      .get('/api/test-audited/vat-123')
      .expect(200);
    const rows = await pool.query(
      "SELECT actor, object_type, object_id, detail FROM audit_log WHERE action = 'test.action'",
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      actor: 'system',
      object_type: 'thing',
      object_id: 'vat-123',
    });
    expect(rows.rows[0].detail).toMatchObject({ method: 'GET' });
  });

  it('@Audited: handler LỖI → KHÔNG ghi audit (AC 3)', async () => {
    await request(app.getHttpServer())
      .get('/api/test-audited/fail/always')
      .expect(400);
    await new Promise((r) => setTimeout(r, 200)); // negative case: chờ ngắn cho chắc
    const rows = await pool.query(
      "SELECT 1 FROM audit_log WHERE action = 'test.should_not_log'",
    );
    expect(rows.rowCount).toBe(0);
  });

  it('grep-test: không câu update/delete nào trỏ vào auditLogTable trong src/ (AC 1)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) {
          const src = readFileSync(p, 'utf8');
          if (
            /\.(update|delete)\(\s*auditLogTable\s*\)/.test(src) ||
            /UPDATE\s+audit_log|DELETE\s+FROM\s+audit_log|TRUNCATE\s+audit_log/i.test(
              src,
            )
          ) {
            offenders.push(p);
          }
        }
      }
    };
    walk(join(__dirname, '..', 'src'));
    expect(offenders).toEqual([]);
  });
});
