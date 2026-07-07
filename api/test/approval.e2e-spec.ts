import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.helper';

/** E2E phân quyền hàng đợi duyệt (story 3.4, NFR-7). */
describe('Admin duyệt request — phân quyền (story 3.4)', () => {
  let app: INestApplication;
  const asMember = { 'x-dev-user-sub': 'member-1', 'x-dev-role': 'member' };
  const UUID = '2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f';

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTH_DEV_MODE;
  });

  it('member → 403 cả 3 endpoint', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/tickets/pending-approval')
      .set(asMember)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${UUID}/approve`)
      .set(asMember)
      .send({ version: 1 })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${UUID}/reject`)
      .set(asMember)
      .send({ version: 1, reason: 'x' })
      .expect(403);
  });

  it('anonymous → 401', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/tickets/pending-approval')
      .expect(401);
  });

  it('reject thiếu reason → 400 (admin)', async () => {
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${UUID}/reject`)
      .set({ 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' })
      .send({ version: 1 })
      .expect(400);
  });
});
