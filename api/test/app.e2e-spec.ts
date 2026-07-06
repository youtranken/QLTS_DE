import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.helper';

describe('Skeleton api (AC 3, 7)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    delete process.env.AUTH_DEV_MODE;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health → 200 { status: ok }', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('lỗi trả đúng shape { statusCode, code, message } (route không tồn tại)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/khong-ton-tai')
      .expect(404);
    expect(res.body).toEqual({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: expect.any(String),
    });
    expect(Object.keys(res.body).sort()).toEqual([
      'code',
      'message',
      'statusCode',
    ]);
  });
});
