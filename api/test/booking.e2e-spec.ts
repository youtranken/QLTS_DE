import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.helper';

/**
 * E2E availability — phân quyền + validate DTO TRƯỚC service (story 3.1b, NFR-7).
 * Hành vi + validate service-level (range/window) ở booking-availability.db-spec (DB thật).
 */
describe('Availability — phân quyền & validate DTO (story 3.1b)', () => {
  let app: INestApplication;
  const asMember = { 'x-dev-user-sub': 'member-1', 'x-dev-role': 'member' };
  const OFF = '2026-08-01T09:00:00+07:00';
  const UUID = '2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f';

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
      .get('/api/booking/availability')
      .query({ from: OFF, to: '2026-08-01T11:00:00+07:00' })
      .expect(401);
  });

  it('from KHÔNG offset → 400 (party phiên 7 — chống lệch giờ)', async () => {
    await request(app.getHttpServer())
      .get('/api/booking/availability')
      .query({ from: '2026-08-01T09:00:00', to: '2026-08-01T11:00:00+07:00' })
      .set(asMember)
      .expect(400);
  });

  it('thiếu tham số from → 400', async () => {
    await request(app.getHttpServer())
      .get('/api/booking/availability')
      .query({ to: '2026-08-01T11:00:00+07:00' })
      .set(asMember)
      .expect(400);
  });

  it('to không phải ISO-8601 → 400', async () => {
    await request(app.getHttpServer())
      .get('/api/booking/availability')
      .query({ from: OFF, to: 'khong-phai-ngay' })
      .set(asMember)
      .expect(400);
  });

  it('calendar: anonymous → 401 (story 3.2)', async () => {
    await request(app.getHttpServer())
      .get(`/api/booking/machines/${UUID}/calendar`)
      .expect(401);
  });

  it('calendar: :id không phải UUID → 400', async () => {
    await request(app.getHttpServer())
      .get('/api/booking/machines/khong-uuid/calendar')
      .set(asMember)
      .expect(400);
  });

  it('calendar: weekStart KHÔNG offset → 400', async () => {
    await request(app.getHttpServer())
      .get(`/api/booking/machines/${UUID}/calendar`)
      .query({ weekStart: '2026-08-01T00:00:00' })
      .set(asMember)
      .expect(400);
  });
});
