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

  it('route cần đăng nhập không có identity → 401 UNAUTHENTICATED (default-secure, AC 9 story 1.2)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .expect(401);
    expect(res.body).toEqual({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
      message: expect.any(String),
    });
  });

  it('cookie qlts_sid rác (không phải uuid) → 401 sạch + xóa cookie, KHÔNG 500', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', 'qlts_sid=khong-phai-uuid')
      .expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    const cleared = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cleared.some((c) => c.startsWith('qlts_sid=;'))).toBe(true);
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
