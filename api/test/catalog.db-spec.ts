import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 8.1 — danh mục Loại/Hãng/Cấu hình (catalog): đếm tách máy/phần mềm, ẩn/hiện, rename. */
if (!process.env.DATABASE_URL) {
  throw new Error('[catalog.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[catalog.db-spec] Từ chối chạy '${dbName}'.`);
}

const asSa = { 'x-dev-user-sub': 'sa-cat', 'x-dev-role': 'sa' };
const asMember = { 'x-dev-user-sub': 'mem-cat', 'x-dev-role': 'member' };

describe('Catalog danh mục (story 8.1)', () => {
  let app: INestApplication;
  let pool: Pool;

  const get = (qs: string, headers = asSa) =>
    request(app.getHttpServer()).get(`/api/admin/catalog${qs}`).set(headers);
  const post = (path: string, body: object, headers = asSa) =>
    request(app.getHttpServer())
      .post(`/api/admin/catalog${path}`)
      .set(headers)
      .send(body);

  const idOf = async (kind: string, value: string): Promise<string> => {
    const r = await pool.query(
      'SELECT id FROM catalog WHERE kind=$1 AND value=$2',
      [kind, value],
    );
    return r.rows[0].id as string;
  };

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS catalog, department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    // assets: biến thể trùng hoa/thường + brand + 1 software (brand Dell) → test đếm tách
    // máy/phần mềm theo cùng giá trị danh mục + loại 'software' khỏi danh mục Loại.
    await pool.query(
      `INSERT INTO assets (code, type, brand) VALUES
        ('A1','Laptop','Dell'),
        ('A2','laptop','Dell'),
        ('A3','monitor',NULL)`,
    );
    // Máy đã soft-purge (purged_at) KHÔNG được tính vào số liệu danh mục (khớp list/nav).
    await pool.query(
      `INSERT INTO assets (code, type, brand, purged_at) VALUES
        ('PURGED-1','Laptop','Dell', now())`,
    );
    await pool.query(
      `INSERT INTO assets (code, type, license_type, license_name, brand) VALUES
        ('SW1','software','perpetual','WinX','Dell')`,
    );
    // catalog: seed migration chạy lúc assets rỗng → tự thêm giá trị cho khớp assets trên
    await pool.query(
      `INSERT INTO catalog (kind, value) VALUES
        ('type','Laptop'),('type','laptop'),('type','monitor'),('type','software'),
        ('brand','Dell')`,
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('AC1 — SA GET theo kind trả giá trị + đếm tách máy/phần mềm (exact)', async () => {
    type Row = { value: string; deviceCount: number; softwareCount: number };
    const res = await get('?kind=type').expect(200);
    const byValue = Object.fromEntries(
      (res.body as Row[]).map((r) => [r.value, r]),
    );
    expect(byValue.Laptop).toMatchObject({ deviceCount: 1, softwareCount: 0 });
    expect(byValue.laptop).toMatchObject({ deviceCount: 1, softwareCount: 0 });
    expect(byValue.monitor).toMatchObject({ deviceCount: 1, softwareCount: 0 });
    // 'software' là loại hệ thống → KHÔNG lộ trong danh mục Loại (review M1)
    expect(byValue).not.toHaveProperty('software');
    // Brand Dell: 2 máy (A1,A2) + 1 phần mềm (SW1) → đếm tách đúng
    const br = await get('?kind=brand').expect(200);
    const dell = (br.body as Row[]).find((r) => r.value === 'Dell');
    expect(dell).toMatchObject({ deviceCount: 2, softwareCount: 1 });
  });

  it('AC1 — member → 403', async () => {
    await get('?kind=type', asMember).expect(403);
    await post('', { kind: 'type', value: 'X' }, asMember).expect(403);
  });

  it('AC2 — tạo giá trị mới → 200 + audit catalog.create', async () => {
    await post('', { kind: 'brand', value: '  HP  ' }).expect(201);
    const r = await pool.query(
      "SELECT value FROM catalog WHERE kind='brand' AND value='HP'",
    );
    expect(r.rowCount).toBe(1); // đã trim
    const a = await pool.query(
      "SELECT count(*)::int n FROM audit_log WHERE action='catalog.create'",
    );
    expect(a.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('AC2 — tạo trùng case-insensitive → 409', async () => {
    await post('', { kind: 'type', value: 'LAPTOP' }).expect(409);
  });

  it('AC3 — ẩn giá trị (active=false) → mất khỏi activeOnly', async () => {
    const id = await idOf('type', 'monitor');
    await request(app.getHttpServer())
      .put(`/api/admin/catalog/${id}`)
      .set(asSa)
      .send({ active: false })
      .expect(200);
    const active = await get('?kind=type&activeOnly=true').expect(200);
    const values = (active.body as Array<{ value: string }>).map(
      (r) => r.value,
    );
    expect(values).not.toContain('monitor');
    expect(values).toContain('Laptop');
  });

  it('Sửa — chặn rename qua/về loại hệ thống "software" → 400 (không 500)', async () => {
    const swId = await idOf('type', 'software');
    const laptopId = await idOf('type', 'Laptop');
    // rename TỪ software (cascade assets.type='software'→X có thể phá CHECK 0012)
    await request(app.getHttpServer())
      .put(`/api/admin/catalog/${swId}`)
      .set(asSa)
      .send({ value: 'SoftwareX' })
      .expect(400);
    // rename VỀ software (đưa máy không license sang type='software' → 23514)
    await request(app.getHttpServer())
      .put(`/api/admin/catalog/${laptopId}`)
      .set(asSa)
      .send({ value: 'software' })
      .expect(400);
  });

  it('Sửa — rename đổi tên + cascade text tài sản + audit catalog.rename', async () => {
    const id = await idOf('type', 'monitor');
    await request(app.getHttpServer())
      .put(`/api/admin/catalog/${id}`)
      .set(asSa)
      .send({ value: 'Monitor' })
      .expect(200);
    const c = await pool.query(
      "SELECT count(*)::int n FROM catalog WHERE kind='type' AND value='Monitor'",
    );
    expect(c.rows[0].n).toBe(1);
    const a = await pool.query(
      "SELECT count(*)::int n FROM assets WHERE type='Monitor'",
    );
    expect(a.rows[0].n).toBe(1); // A3 đổi monitor → Monitor
    const audit = await pool.query(
      "SELECT detail FROM audit_log WHERE action='catalog.rename' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.rows[0].detail).toMatchObject({
      from: 'monitor',
      to: 'Monitor',
      assetsUpdated: 1,
    });
  });

  it('Sửa — rename trùng giá trị khác (gợi ý gộp) → 409', async () => {
    const id = await idOf('type', 'Monitor');
    // 'Laptop' đã tồn tại → đổi Monitor thành 'LAPTOP' (trùng case-insensitive) → 409
    await request(app.getHttpServer())
      .put(`/api/admin/catalog/${id}`)
      .set(asSa)
      .send({ value: 'LAPTOP' })
      .expect(409);
  });
});
