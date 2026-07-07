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

  it('deliver/return: member → 403 (story 3.6)', async () => {
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${UUID}/deliver`)
      .set(asMember)
      .send({ version: 1 })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/${UUID}/return`)
      .set(asMember)
      .send({ version: 1, note: 'x' })
      .expect(403);
  });

  it('photo endpoint: anonymous → 401 (story 3.6)', async () => {
    await request(app.getHttpServer())
      .get(`/api/booking/tickets/${UUID}/photos/${UUID}`)
      .expect(401);
  });

  it('create-for: member → 403 (endpoint bypass mạnh nhất — story 3.7)', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/tickets/create-for')
      .set(asMember)
      .send({
        borrowerSub: 'x',
        assetId: UUID,
        from: '2026-08-01T09:00:00+07:00',
        to: '2026-08-01T11:00:00+07:00',
        mode: 'schedule',
      })
      .expect(403);
  });

  it('create-for: anonymous → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/tickets/create-for')
      .send({
        borrowerSub: 'x',
        assetId: UUID,
        from: 'a',
        to: 'b',
        mode: 'now',
      })
      .expect(401);
  });

  it('dashboard count endpoints: member → 403 (story 3.12)', async () => {
    for (const path of ['overdue', 'awaiting-pickup', 'in-use']) {
      await request(app.getHttpServer())
        .get(`/api/admin/tickets/${path}`)
        .set(asMember)
        .expect(403);
    }
  });

  it('create-for: mode sai → 400 (admin)', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/tickets/create-for')
      .set({ 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' })
      .send({
        borrowerSub: 'x',
        assetId: UUID,
        from: '2026-08-01T09:00:00+07:00',
        to: '2026-08-01T11:00:00+07:00',
        mode: 'invalid',
      })
      .expect(400);
  });
});
