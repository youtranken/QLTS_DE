import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.helper';

/**
 * E2E phân quyền + validate sổ tài sản (story 2.1, NFR-7) — seam AUTH_DEV_MODE.
 * Nghiệp vụ ghi DB thật ở assets.db-spec; ở đây chỉ request bị chặn TRƯỚC service.
 */
describe('Sổ tài sản — phân quyền & validate (story 2.1)', () => {
  let app: INestApplication;
  const UUID = '2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f';

  const asMember = { 'x-dev-user-sub': 'member-1', 'x-dev-role': 'member' };
  const asAdmin = { 'x-dev-user-sub': 'admin-1', 'x-dev-role': 'admin' };

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTH_DEV_MODE;
  });

  it('member gọi list/tạo/sửa → 403 (AC 1, NFR-7)', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/assets')
      .set(asMember)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asMember)
      .send({ code: 'A-1', type: 'laptop' })
      .expect(403);
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}`)
      .set(asMember)
      .send({ code: 'A-1', type: 'laptop', version: 1 })
      .expect(403);
  });

  it('không đăng nhập → 401', async () => {
    await request(app.getHttpServer()).get('/api/admin/assets').expect(401);
  });

  it('thiếu code/type → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ type: 'laptop' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: 'A-1' })
      .expect(400);
  });

  it('giá âm / ngày sai định dạng / ngày không tồn tại → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: 'A-1', type: 'laptop', cost: -5 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: 'A-1', type: 'laptop', startDate: '15/01/2026' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: 'A-1', type: 'laptop', endDate: '2026-13-40' })
      .expect(400);
  });

  it('PUT thiếu version (optimistic lock bắt buộc) → 400 (AC 3)', async () => {
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}`)
      .set(asAdmin)
      .send({ code: 'A-1', type: 'laptop' })
      .expect(400);
  });

  it('id không phải uuid → 400 (không lộ 500)', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/assets/khong-phai-uuid')
      .set(asAdmin)
      .expect(400);
  });
});
