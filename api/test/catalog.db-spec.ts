import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 8.1 — danh mục Loại/Hãng/Cấu hình (catalog) + gộp giá trị trùng. */
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
  const post = (path: string, body: unknown, headers = asSa) =>
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
    // assets có biến thể trùng hoa/thường + brand → tính usage + gộp
    await pool.query(
      `INSERT INTO assets (code, type, brand) VALUES
        ('A1','Laptop','Dell'),
        ('A2','laptop','Dell'),
        ('A3','monitor',NULL)`,
    );
    // catalog: seed migration chạy lúc assets rỗng → tự thêm giá trị cho khớp assets trên
    await pool.query(
      `INSERT INTO catalog (kind, value) VALUES
        ('type','Laptop'),('type','laptop'),('type','monitor'),
        ('brand','Dell')`,
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('AC1 — SA GET theo kind trả giá trị + usage (số tài sản exact)', async () => {
    const res = await get('?kind=type').expect(200);
    const byValue = Object.fromEntries(
      (res.body as Array<{ value: string; usage: number }>).map((r) => [
        r.value,
        r.usage,
      ]),
    );
    expect(byValue).toMatchObject({ Laptop: 1, laptop: 1, monitor: 1 });
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

  it('AC4 — gộp laptop → Laptop: preview đếm, merge đổi text + xóa nguồn + audit', async () => {
    const fromId = await idOf('type', 'laptop');
    const toId = await idOf('type', 'Laptop');
    const prev = await get(`/merge-preview?from=${fromId}&to=${toId}`).expect(
      200,
    );
    expect(prev.body).toMatchObject({
      fromValue: 'laptop',
      toValue: 'Laptop',
      assetCount: 1,
    });
    const res = await post('/merge', { from: fromId, to: toId }).expect(201);
    expect(res.body).toMatchObject({ assetsUpdated: 1 });
    // asset A2 đổi 'laptop' → 'Laptop'
    const a = await pool.query(
      "SELECT count(*)::int n FROM assets WHERE type='Laptop'",
    );
    expect(a.rows[0].n).toBe(2);
    // entry nguồn đã xóa
    const gone = await pool.query(
      "SELECT count(*)::int n FROM catalog WHERE kind='type' AND value='laptop'",
    );
    expect(gone.rows[0].n).toBe(0);
    const audit = await pool.query(
      "SELECT detail FROM audit_log WHERE action='catalog.merge' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.rows[0].detail).toMatchObject({
      from: 'laptop',
      to: 'Laptop',
      assetsUpdated: 1,
    });
  });

  it('AC4 — gộp khác kind → 400', async () => {
    const typeId = await idOf('type', 'Laptop');
    const brandId = await idOf('brand', 'Dell');
    await post('/merge', { from: brandId, to: typeId }).expect(400);
  });
});
