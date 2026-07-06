import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

if (!process.env.DATABASE_URL) {
  throw new Error('[roles.db-spec] DATABASE_URL chưa đặt — cần Postgres thật.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[roles.db-spec] Từ chối chạy trên DB '${dbName}'.`);
}

const SA_ENV_SUB = 'sub-sa-tu-env';

describe('Ba vai & bổ nhiệm Admin trên DB thật (story 1.5)', () => {
  let app: INestApplication;
  let pool: Pool;

  const asSa = () => ({ 'x-dev-user-sub': 'sa-test', 'x-dev-role': 'sa' });

  /** Tạo session OIDC giả trực tiếp DB — kiểm "hiệu lực ngay không cần login lại". */
  async function fakeSession(sub: string): Promise<string> {
    const sid = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, user_sub, refresh_token, access_token_exp, claims, csrf_token)
       VALUES ($1, $2, 'rt-x', now() + interval '5 minutes', $3, 'csrf-x')`,
      [sid, sub, JSON.stringify({ sub, full_name: 'Người Test' })],
    );
    return sid;
  }

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    process.env.SA_SUBS = SA_ENV_SUB;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name) VALUES
       ('sub-m1', 'm1@pmh.com.vn', 'Member Một'),
       ('${SA_ENV_SUB}', 'sa@pmh.com.vn', 'SA Env')`,
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
    delete process.env.SA_SUBS;
  });

  it('SA bổ nhiệm member → role đổi + audit ghi from/to đúng actor (AC 4)', async () => {
    await request(app.getHttpServer())
      .put('/api/admin/users/sub-m1/role')
      .set(asSa())
      .send({ role: 'admin' })
      .expect(200);
    const row = await pool.query("SELECT role FROM users WHERE sub = 'sub-m1'");
    expect(row.rows[0].role).toBe('admin');
    const audit = await pool.query(
      "SELECT actor, object_id, detail FROM audit_log WHERE action = 'users.role_change'",
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({
      actor: 'sa-test',
      object_id: 'sub-m1',
    });
    expect(audit.rows[0].detail).toEqual({ from: 'member', to: 'admin' });
  });

  it('vai mới hiệu lực NGAY với phiên OIDC đang sống — không cần đăng nhập lại (AC 1)', async () => {
    const sid = await fakeSession('sub-m1');
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', `qlts_sid=${sid}`)
      .expect(200);
    expect(res.body.role).toBe('admin');
    // miễn nhiệm → request kế tiếp thấy member ngay
    await request(app.getHttpServer())
      .put('/api/admin/users/sub-m1/role')
      .set(asSa())
      .send({ role: 'member' })
      .expect(200);
    const res2 = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', `qlts_sid=${sid}`)
      .expect(200);
    expect(res2.body.role).toBe('member');
  });

  it('sub ∈ SA_SUBS → identity role sa (override bảng users) (AC 1)', async () => {
    const sid = await fakeSession(SA_ENV_SUB);
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', `qlts_sid=${sid}`)
      .expect(200);
    expect(res.body.role).toBe('sa');
  });

  it('đổi vai của SA-từ-env → 403 SA_ROLE_IMMUTABLE (AC 4)', async () => {
    const res = await request(app.getHttpServer())
      .put(`/api/admin/users/${SA_ENV_SUB}/role`)
      .set(asSa())
      .send({ role: 'member' })
      .expect(403);
    expect(res.body.code).toBe('SA_ROLE_IMMUTABLE');
  });

  it('target không tồn tại → 404 USER_NOT_FOUND (AC 4)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/admin/users/khong-ton-tai/role')
      .set(asSa())
      .send({ role: 'admin' })
      .expect(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('list: tìm theo tên/email + phân trang server-side (AC 3)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/users?search=Member&page=1&pageSize=10')
      .set(asSa())
      .expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].sub).toBe('sub-m1');
    // admin cũng xem được list (1.6 dùng)
    await request(app.getHttpServer())
      .get('/api/admin/users')
      .set({ 'x-dev-user-sub': 'admin-1', 'x-dev-role': 'admin' })
      .expect(200);
    // member thì không
    await request(app.getHttpServer())
      .get('/api/admin/users')
      .set({ 'x-dev-user-sub': 'member-1', 'x-dev-role': 'member' })
      .expect(403);
  });
});
