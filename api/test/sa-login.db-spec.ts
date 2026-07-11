import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { hashPassword } from '../src/modules/auth/local-sa.service';
import { createTestApp } from './test-app.helper';

if (!process.env.DATABASE_URL) {
  throw new Error('[sa-login.db-spec] DATABASE_URL chưa đặt — cần Postgres thật.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[sa-login.db-spec] Từ chối chạy trên DB '${dbName}'.`);
}

const SA_USER = 'sa-e2e';
const SA_PASS = 'CorrectPw#e2e-2026';

describe('SA local break-glass login (story 10.1)', () => {
  let app: INestApplication;
  let pool: Pool;

  const login = (body: { username: string; password: string }, ip: string) =>
    request(app.getHttpServer())
      .post('/api/auth/sa-login')
      .set('X-Forwarded-For', ip)
      .send(body);

  beforeAll(async () => {
    // LocalSaService đọc env lúc khởi tạo → phải set TRƯỚC createTestApp
    process.env.LOCAL_SA_USERNAME = SA_USER;
    process.env.LOCAL_SA_PASSWORD_HASH = hashPassword(SA_PASS);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES
       ('sub-member', 'm@pmh.com.vn', 'Member Test', 'member')`,
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.LOCAL_SA_USERNAME;
    delete process.env.LOCAL_SA_PASSWORD_HASH;
  });

  it('đúng username/password → 200 + phiên role=sa, sub=local:sa', async () => {
    const res = await login(
      { username: SA_USER, password: SA_PASS },
      '10.0.0.1',
    ).expect(200);
    const cookie = res.headers['set-cookie'];
    expect(cookie).toBeDefined();

    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', cookie)
      .expect(200);
    expect(me.body.role).toBe('sa');
    expect(me.body.sub).toBe('local:sa');

    const audit = await pool.query(
      "SELECT actor FROM audit_log WHERE action = 'auth.sa_login' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.rows[0].actor).toBe('local:sa');
  });

  it('SA (local) bổ nhiệm được admin cho member', async () => {
    const res = await login(
      { username: SA_USER, password: SA_PASS },
      '10.0.0.2',
    ).expect(200);
    const cookie = res.headers['set-cookie'] as unknown as string[];
    const csrf = (
      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookie)
        .expect(200)
    ).body.csrfToken as string;

    await request(app.getHttpServer())
      .put('/api/admin/users/sub-member/role')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ role: 'admin' })
      .expect(200);
    const row = await pool.query(
      "SELECT role FROM users WHERE sub = 'sub-member'",
    );
    expect(row.rows[0].role).toBe('admin');
  });

  it('sai mật khẩu → 401 mơ hồ (không phân biệt user/pass)', async () => {
    const res = await login(
      { username: SA_USER, password: 'wrong' },
      '10.0.0.3',
    ).expect(401);
    expect(res.body.code).toBe('SA_LOGIN_INVALID');
  });

  it('sai username → 401 mơ hồ (cùng thông điệp)', async () => {
    const res = await login(
      { username: 'nope', password: SA_PASS },
      '10.0.0.4',
    ).expect(401);
    expect(res.body.code).toBe('SA_LOGIN_INVALID');
  });

  it('5 lần sai liên tiếp trên cùng IP → 429 khoá tạm', async () => {
    const ip = '10.9.9.9';
    for (let i = 0; i < 4; i += 1) {
      await login({ username: SA_USER, password: 'bad' }, ip).expect(401);
    }
    // lần thứ 5 kích hoạt khoá
    await login({ username: SA_USER, password: 'bad' }, ip).expect(429);
    // đang khoá: kể cả mật khẩu ĐÚNG cũng 429
    const res = await login({ username: SA_USER, password: SA_PASS }, ip).expect(
      429,
    );
    expect(res.body.code).toBe('SA_LOGIN_LOCKED');
  });

  it('IP khác không bị ảnh hưởng bởi lockout của IP kia', async () => {
    await login({ username: SA_USER, password: SA_PASS }, '10.5.5.5').expect(
      200,
    );
  });
});
