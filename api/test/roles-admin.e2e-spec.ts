import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.helper';

/**
 * E2E phân quyền màn Vai trò (story 1.5, NFR-7) — seam AUTH_DEV_MODE.
 * Nghiệp vụ ghi DB thật nằm ở roles.db-spec; ở đây chỉ chặn 401/403/validate
 * (không đụng DB — bị chặn trước khi vào service).
 */
describe('Vai trò — phân quyền (story 1.5)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTH_DEV_MODE;
  });

  it('member gọi API bổ nhiệm → 403 (AC 5)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/admin/users/ai-do/role')
      .set('x-dev-user-sub', 'member-1')
      .set('x-dev-role', 'member')
      .send({ role: 'admin' })
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('admin gọi API chỉ-SA (đổi role) → 403 (AC 5)', async () => {
    await request(app.getHttpServer())
      .put('/api/admin/users/ai-do/role')
      .set('x-dev-user-sub', 'admin-1')
      .set('x-dev-role', 'admin')
      .send({ role: 'admin' })
      .expect(403);
  });

  it('không đăng nhập → 401', async () => {
    await request(app.getHttpServer())
      .put('/api/admin/users/ai-do/role')
      .send({ role: 'admin' })
      .expect(401);
  });

  it('role=sa trong body → 400 validate (CẤM nâng SA qua API, AC 2)', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/admin/users/ai-do/role')
      .set('x-dev-user-sub', 'sa-1')
      .set('x-dev-role', 'sa')
      .send({ role: 'sa' })
      .expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('member gọi API gán quyền → 403 (1.6, AC 4)', async () => {
    await request(app.getHttpServer())
      .put('/api/admin/users/ai-do/permissions')
      .set('x-dev-user-sub', 'member-1')
      .set('x-dev-role', 'member')
      .send({ canLongTerm: true })
      .expect(403);
  });

  it('gán quyền body rỗng (không cờ nào) → 400 (1.6)', async () => {
    await request(app.getHttpServer())
      .put('/api/admin/users/ai-do/permissions')
      .set('x-dev-user-sub', 'admin-1')
      .set('x-dev-role', 'admin')
      .send({})
      .expect(400);
  });

  it('gán quyền giá trị không phải boolean → 400 (1.6)', async () => {
    await request(app.getHttpServer())
      .put('/api/admin/users/ai-do/permissions')
      .set('x-dev-user-sub', 'admin-1')
      .set('x-dev-role', 'admin')
      .send({ canLongTerm: 'yes' })
      .expect(400);
  });

  it('SA tự đổi vai chính mình → 403 SELF_ROLE_CHANGE', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/admin/users/sa-1/role')
      .set('x-dev-user-sub', 'sa-1')
      .set('x-dev-role', 'sa')
      .send({ role: 'member' })
      .expect(403);
    expect(res.body.code).toBe('SELF_ROLE_CHANGE');
  });
});
