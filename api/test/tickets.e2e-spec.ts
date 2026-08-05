import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.helper';

/**
 * E2E submit đặt mượn — phân quyền + validate DTO TRƯỚC service (story 3.1c, NFR-7).
 * Hành vi (quota/SLOT_TAKEN/held) ở tickets.db-spec (DB thật).
 */
describe('Submit đặt mượn — phân quyền & validate DTO (story 3.1c)', () => {
  let app: INestApplication;
  const asMember = { 'x-dev-user-sub': 'member-1', 'x-dev-role': 'member' };
  const asAdmin = { 'x-dev-user-sub': 'admin-1', 'x-dev-role': 'admin' };
  const UUID = '2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f';
  const OK = {
    assetId: UUID,
    from: '2026-08-01T09:00:00+07:00',
    to: '2026-08-01T11:00:00+07:00',
  };

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTH_DEV_MODE;
  });

  it('anonymous → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/booking')
      .send(OK)
      .expect(401);
  });

  it('admin/sa POST /booking → 403 (Admin/SA không đi luồng mượn — mục 3 PRD)', async () => {
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(asAdmin)
      .send(OK)
      .expect(403);
  });

  it('assetId không phải UUID → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(asMember)
      .send({ ...OK, assetId: 'khong-uuid' })
      .expect(400);
  });

  it('from KHÔNG offset → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/booking')
      .set(asMember)
      .send({ ...OK, from: '2026-08-01T09:00:00' })
      .expect(400);
  });

  it('my-tickets: anonymous → 401 (story 3.3)', async () => {
    await request(app.getHttpServer())
      .get('/api/booking/my-tickets')
      .expect(401);
  });

  it('my-tickets: admin → 403 (chỉ member)', async () => {
    await request(app.getHttpServer())
      .get('/api/booking/my-tickets')
      .set(asAdmin)
      .expect(403);
  });

  it('cancel: thiếu version → 400', async () => {
    await request(app.getHttpServer())
      .post(`/api/booking/my-tickets/${UUID}/cancel`)
      .set(asMember)
      .send({})
      .expect(400);
  });
});
