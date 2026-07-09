import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 6.2 — viewer audit log (chỉ SA). */
if (!process.env.DATABASE_URL) {
  throw new Error('[audit-viewer.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[audit-viewer.db-spec] Từ chối chạy '${dbName}'.`);
}

const asSa = { 'x-dev-user-sub': 'sa-av', 'x-dev-role': 'sa' };
const asAdmin = { 'x-dev-user-sub': 'adm-av', 'x-dev-role': 'admin' };

describe('Audit log viewer (story 6.2)', () => {
  let app: INestApplication;
  let pool: Pool;

  const ins = (
    actor: string,
    action: string,
    objectType: string | null,
    objectId: string | null,
    detail: Record<string, unknown> | null,
    createdAt: string,
  ) =>
    pool.query(
      `INSERT INTO audit_log (actor, action, object_type, object_id, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [actor, action, objectType, objectId, detail, createdAt],
    );

  const list = (qs: string, headers = asSa) =>
    request(app.getHttpServer())
      .get(`/api/admin/audit${qs ? `?${qs}` : ''}`)
      .set(headers);

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await ins(
      'u1',
      'assets.create',
      'asset',
      'a-111',
      { code: 'X1' },
      '2026-06-01T03:00:00Z',
    );
    await ins(
      'u2',
      'tickets.create',
      'ticket',
      't-222',
      null,
      '2026-06-15T03:00:00Z',
    );
    await ins(
      'system',
      'tickets.auto_approve',
      'ticket',
      't-222',
      null,
      '2026-06-15T03:00:01Z',
    );
    await ins(
      'u1',
      'assets.export',
      'assets_export',
      null,
      { rowCount: 5 },
      '2026-07-01T03:00:00Z',
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('AC1 — SA xem được; sắp created_at giảm dần', async () => {
    const res = await list('').expect(200);
    expect(res.body.total).toBe(4);
    const times = (res.body.items as { createdAt: string }[]).map((r) =>
      new Date(r.createdAt).getTime(),
    );
    expect(times).toEqual([...times].sort((a, b) => b - a)); // desc
  });

  it('AC1 — Admin + member → 403 cả /audit lẫn /actions (chỉ SA)', async () => {
    const asMember = { 'x-dev-user-sub': 'mem-av', 'x-dev-role': 'member' };
    const a1 = await list('', asAdmin).expect(403);
    expect(a1.body.code).toBe('FORBIDDEN_ROLE');
    await list('', asMember).expect(403);
    await request(app.getHttpServer())
      .get('/api/admin/audit/actions')
      .set(asAdmin)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/admin/audit/actions')
      .set(asMember)
      .expect(403);
  });

  it('AC1 — actor=system hiện đúng (thao tác auto)', async () => {
    const res = await list('actor=system').expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].action).toBe('tickets.auto_approve');
  });

  it('AC2 — lọc action=assets.export ra dòng export (kênh exfil có vết)', async () => {
    const res = await list('action=assets.export').expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].objectType).toBe('assets_export');
    expect(res.body.items[0].detail).toMatchObject({ rowCount: 5 });
  });

  it('AC1 — lọc objectId + khoảng thời gian VN', async () => {
    const byObj = await list('objectId=t-222').expect(200);
    expect(byObj.body.total).toBe(2);
    // chỉ tháng 6 (VN): 2026-06-01..2026-06-30
    const june = await list('from=2026-06-01&to=2026-06-30').expect(200);
    expect(june.body.total).toBe(3); // 3 dòng tháng 6, loại dòng export tháng 7
  });

  it('AC3 — /actions trả distinct action', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/audit/actions')
      .set(asSa)
      .expect(200);
    expect(res.body).toEqual([
      'assets.create',
      'assets.export',
      'tickets.auto_approve',
      'tickets.create',
    ]);
  });

  it('to < from → 400', async () => {
    await list('from=2026-07-01&to=2026-06-01').expect(400);
  });
});
