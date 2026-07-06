import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import * as ExcelJS from 'exceljs';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

if (!process.env.DATABASE_URL) {
  throw new Error(
    '[import.db-spec] DATABASE_URL chưa đặt — cần Postgres thật.',
  );
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[import.db-spec] Từ chối chạy trên DB '${dbName}'.`);
}

const HEADERS = [
  'NO.',
  'USER',
  'CODE',
  'ASSET TYPE',
  'CONFIGURATION',
  'COST',
  'START DATE',
  'END DATE',
  'PLACE',
  'STATUS',
  'NOTE',
];

async function buildXlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('So');
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('Import Excel go-live trên DB thật (story 2.9)', () => {
  let app: INestApplication;
  let pool: Pool;

  const asAdmin = () => ({
    'x-dev-user-sub': 'admin-t',
    'x-dev-role': 'admin',
  });

  const assetCount = async (): Promise<number> =>
    (await pool.query('SELECT count(*)::int AS n FROM assets')).rows[0]
      .n as number;

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(`
      INSERT INTO users (sub, email, employee_code, full_name) VALUES
      ('sub-a', 'a@pmh.com.vn', 'NV001', 'Nguyễn Văn A'),
      ('sub-t1', 't1@pmh.com.vn', 'NV002', 'Trùng Tên'),
      ('sub-t2', 't2@pmh.com.vn', 'NV003', 'Trùng Tên')
    `);
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('preview (dry-run): báo lỗi theo dòng (trùng DB + trong file), KHÔNG ghi gì (AC 1)', async () => {
    await pool.query(
      "INSERT INTO assets (code, type) VALUES ('DA-CO', 'laptop')",
    );
    const before = await assetCount();
    const buf = await buildXlsx([
      [1, 'Nguyễn Văn A', 'M-OK', 'laptop', '', 1000, '', '', '3', '', ''],
      [2, '', 'DA-CO', 'desktop', '', '', '', '', '', '', ''], // trùng DB
      [3, '', '', 'monitor', '', '', '', '', '', '', ''], // thiếu CODE
    ]);
    const res = await request(app.getHttpServer())
      .post('/api/admin/assets-import/preview')
      .set(asAdmin())
      .attach('file', buf, 'so-cu.xlsx')
      .expect(200);
    expect(res.body).toMatchObject({ total: 3, valid: 1, invalid: 2 });
    const rows = res.body.rows as Array<{ errors: string[] }>;
    expect(rows[1].errors.join(' ')).toContain('đã tồn tại');
    expect(await assetCount()).toBe(before); // dry-run thật
  });

  it('commit khi còn dòng lỗi → 400 IMPORT_HAS_ERRORS, không ghi', async () => {
    const before = await assetCount();
    const buf = await buildXlsx([
      [1, '', '', 'laptop', '', '', '', '', '', '', ''],
    ]);
    const res = await request(app.getHttpServer())
      .post('/api/admin/assets-import/commit')
      .set(asAdmin())
      .attach('file', buf, 'loi.xlsx')
      .expect(400);
    expect(res.body.code).toBe('IMPORT_HAS_ERRORS');
    expect(await assetCount()).toBe(before);
  });

  it('commit sạch: máy match USER + seed history import go-live; software gắn máy CÙNG FILE; USER lạ/nhiều → needs_user_match + imported_user_text (AC 3/4/5)', async () => {
    const buf = await buildXlsx([
      // máy của A (match theo họ tên)
      [
        1,
        'Nguyễn Văn A',
        'IM-M1',
        'laptop',
        'i7',
        25000000,
        '15/01/2026',
        '',
        '3',
        'Đang sử dụng',
        '',
      ],
      // máy của người lạ → cần đối chiếu
      [2, 'Người Lạ', 'IM-M2', 'desktop', '', '', '', '', '5', '', ''],
      // máy của tên trùng 2 người → KHÔNG match (an toàn)
      [3, 'Trùng Tên', 'IM-M3', 'laptop', '', '', '', '', '', '', ''],
      // software của A → gắn vào IM-M1 vừa import trong CÙNG transaction
      [
        4,
        'Nguyễn Văn A',
        'IM-SW1',
        'software',
        'Office 2024',
        3000000,
        '',
        '31/12/2026',
        '',
        '',
        '',
      ],
      // software người lạ → chưa gắn + cần map tay
      [5, 'Người Lạ', 'IM-SW2', 'software', '', '', '', '', '', '', ''],
      // máy thanh lý
      [6, '', 'IM-M4', 'monitor', '', '', '', '', '', 'Thanh lý', ''],
    ]);
    const res = await request(app.getHttpServer())
      .post('/api/admin/assets-import/commit')
      .set(asAdmin())
      .attach('file', buf, 'so-cu.xlsx')
      .expect(200);
    expect(res.body).toMatchObject({
      created: 6,
      machines: 4,
      softwares: 2,
      needsUserMatch: 3, // IM-M2, IM-M3, IM-SW2
    });
    // máy match: assigned + history actor import go-live
    const m1 = (
      await pool.query(
        "SELECT id, assigned_user_sub, needs_user_match, imported_user_text FROM assets WHERE code = 'IM-M1'",
      )
    ).rows[0];
    expect(m1).toMatchObject({
      assigned_user_sub: 'sub-a',
      needs_user_match: false,
      imported_user_text: 'Nguyễn Văn A',
    });
    const hist = await pool.query(
      'SELECT to_user_sub, actor FROM allocation_history WHERE asset_id = $1',
      [m1.id],
    );
    expect(hist.rows[0]).toEqual({
      to_user_sub: 'sub-a',
      actor: 'import go-live',
    });
    // USER lạ + tên trùng 2 người → cờ + text gốc giữ vĩnh viễn
    const m2 = (
      await pool.query(
        "SELECT assigned_user_sub, needs_user_match, imported_user_text FROM assets WHERE code = 'IM-M2'",
      )
    ).rows[0];
    expect(m2).toMatchObject({
      assigned_user_sub: null,
      needs_user_match: true,
      imported_user_text: 'Người Lạ',
    });
    const m3 = (
      await pool.query(
        "SELECT needs_user_match FROM assets WHERE code = 'IM-M3'",
      )
    ).rows[0];
    expect(m3.needs_user_match).toBe(true);
    // software của A gắn đúng IM-M1 (máy vừa import cùng file), term theo END DATE
    const sw1 = (
      await pool.query(
        "SELECT installed_on_asset_id, license_type, end_date::text AS end_date, needs_user_match FROM assets WHERE code = 'IM-SW1'",
      )
    ).rows[0];
    expect(sw1).toMatchObject({
      installed_on_asset_id: m1.id,
      license_type: 'term',
      end_date: '2026-12-31',
      needs_user_match: false,
    });
    // software người lạ: perpetual (không END DATE) + tên fallback + cần map
    const sw2 = (
      await pool.query(
        "SELECT installed_on_asset_id, license_type, license_name, needs_user_match FROM assets WHERE code = 'IM-SW2'",
      )
    ).rows[0];
    expect(sw2).toMatchObject({
      installed_on_asset_id: null,
      license_type: 'perpetual',
      license_name: 'IM-SW2',
      needs_user_match: true,
    });
    // trạng thái map từ sổ cũ
    const m4 = (
      await pool.query("SELECT status FROM assets WHERE code = 'IM-M4'")
    ).rows[0];
    expect(m4.status).toBe('disposed');
    // audit
    const audit = await pool.query(
      "SELECT detail FROM audit_log WHERE action = 'assets.import_commit'",
    );
    expect(audit.rows[0].detail).toMatchObject({ total: 6 });
  });

  it('TOCTOU (AC 3): mã bị tạo song song sau preview → 409 đúng dòng + rollback TOÀN BỘ', async () => {
    const buf = await buildXlsx([
      [1, '', 'RACE-OK', 'laptop', '', '', '', '', '', '', ''],
      [2, '', 'RACE-01', 'desktop', '', '', '', '', '', '', ''],
    ]);
    // preview sạch (RACE-01 chưa tồn tại)
    const prev = await request(app.getHttpServer())
      .post('/api/admin/assets-import/preview')
      .set(asAdmin())
      .attach('file', buf, 'r.xlsx')
      .expect(200);
    expect(prev.body.invalid).toBe(0);
    // ai đó tạo RACE-01 song song
    await pool.query("INSERT INTO assets (code, type) VALUES ('RACE-01', 'x')");
    const before = await assetCount();
    const res = await request(app.getHttpServer())
      .post('/api/admin/assets-import/commit')
      .set(asAdmin())
      .attach('file', buf, 'r.xlsx')
      .expect(409);
    expect(res.body.code).toBe('IMPORT_CODE_TAKEN');
    expect(res.body.rowNumber).toBe(3); // dòng excel thật của RACE-01
    // rollback toàn bộ: RACE-OK cũng KHÔNG được ghi
    expect(await assetCount()).toBe(before);
    const raceOk = await pool.query(
      "SELECT 1 FROM assets WHERE code = 'RACE-OK'",
    );
    expect(raceOk.rowCount).toBe(0);
  });

  it('Đối chiếu lại (AC 6): user mới sync vào → match máy + software, gỡ cờ; chạy lại lần 2 an toàn', async () => {
    // 'Người Lạ' giờ xuất hiện trong danh bạ
    await pool.query(
      "INSERT INTO users (sub, email, full_name) VALUES ('sub-la', 'la@pmh.com.vn', 'Người Lạ')",
    );
    const first = await request(app.getHttpServer())
      .post('/api/admin/assets-import/rematch')
      .set(asAdmin())
      .expect(200);
    // IM-M2 match; IM-SW2 gắn vào IM-M2 (máy duy nhất của Người Lạ) — cùng vòng
    // hoặc vòng sau tùy thứ tự; IM-M3 (tên trùng 2 người) KHÔNG bao giờ match
    expect(first.body.matched).toBeGreaterThanOrEqual(1);
    const second = await request(app.getHttpServer())
      .post('/api/admin/assets-import/rematch')
      .set(asAdmin())
      .expect(200);
    const m2 = (
      await pool.query(
        "SELECT id, assigned_user_sub, needs_user_match FROM assets WHERE code = 'IM-M2'",
      )
    ).rows[0];
    expect(m2).toMatchObject({
      assigned_user_sub: 'sub-la',
      needs_user_match: false,
    });
    const sw2 = (
      await pool.query(
        "SELECT installed_on_asset_id, needs_user_match FROM assets WHERE code = 'IM-SW2'",
      )
    ).rows[0];
    expect(sw2).toMatchObject({
      installed_on_asset_id: m2.id,
      needs_user_match: false,
    });
    // tên trùng vẫn treo — báo remaining
    expect(second.body.remaining).toBeGreaterThanOrEqual(1);
    const m3 = (
      await pool.query(
        "SELECT needs_user_match FROM assets WHERE code = 'IM-M3'",
      )
    ).rows[0];
    expect(m3.needs_user_match).toBe(true);
  });
});
