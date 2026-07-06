import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import type { RequestIdentity } from '../src/modules/auth/identity.guard';
import { Public } from '../src/modules/auth/public.decorator';
import { createTestApp } from './test-app.helper';

/** Controller chỉ dùng trong test: soi identity guard đã gắn vào request.
 *  @Public: từ 1.2 guard enforce 401 mặc định — assertion giữ nguyên (AC 9 story 1.2). */
@Public()
@Controller('test-whoami')
class WhoAmIController {
  @Get()
  whoami(@Req() req: Request & { user?: RequestIdentity }): {
    user: RequestIdentity | null;
  } {
    return { user: req.user ?? null };
  }
}

describe('DevIdentityGuard (AC 9) — flag TẮT (mặc định)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    delete process.env.AUTH_DEV_MODE; // mặc định false
    app = await createTestApp([WhoAmIController]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('header giả bị BỎ QUA hoàn toàn — không có identity', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/test-whoami')
      .set('x-dev-user-sub', 'user-gia-mao')
      .set('x-dev-role', 'sa')
      .expect(200);
    expect(res.body.user).toBeNull();
  });
});

describe('DevIdentityGuard (AC 9) — flag BẬT (NODE_ENV=test thuộc allowlist)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true'; // jest đặt NODE_ENV=test
    app = await createTestApp([WhoAmIController]);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTH_DEV_MODE;
  });

  it('gắn identity đúng user + vai từ header test', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/test-whoami')
      .set('x-dev-user-sub', 'sub-abc-123')
      .set('x-dev-role', 'admin')
      .expect(200);
    expect(res.body.user).toEqual({
      sub: 'sub-abc-123',
      role: 'admin',
      devMode: true,
    });
  });

  it('vai không hợp lệ → không gắn identity', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/test-whoami')
      .set('x-dev-user-sub', 'sub-abc-123')
      .set('x-dev-role', 'superadmin')
      .expect(200);
    expect(res.body.user).toBeNull();
  });

  it('thiếu header → không gắn identity', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/test-whoami')
      .expect(200);
    expect(res.body.user).toBeNull();
  });
});
