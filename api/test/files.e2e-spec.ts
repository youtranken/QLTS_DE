import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.helper';

/** E2E phân quyền + validate module file (story 2.8, NFR-8) — chặn TRƯỚC service. */
describe('Module file — phân quyền & validate (story 2.8)', () => {
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

  it('member → 403 upload + download (NFR-8)', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/files')
      .set(asMember)
      .field('kind', 'image')
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/admin/files/${UUID}/download`)
      .set(asMember)
      .expect(403);
  });

  it('không đăng nhập → 401 (không có đường static public)', async () => {
    await request(app.getHttpServer())
      .get(`/api/admin/files/${UUID}/download`)
      .expect(401);
  });

  it('thiếu file → 400 FILE_REQUIRED; kind lạ → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/admin/files')
      .set(asAdmin)
      .field('kind', 'image')
      .expect(400);
    expect(res.body.code).toBe('FILE_REQUIRED');
    await request(app.getHttpServer())
      .post('/api/admin/files')
      .set(asAdmin)
      .field('kind', 'video')
      .attach('file', Buffer.from('x'), 'x.mp4')
      .expect(400);
  });
});
