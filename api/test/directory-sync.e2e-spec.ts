import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DIRECTORY_CLIENT } from '../src/modules/users/directory.client';
import type { DirectoryClientApi } from '../src/modules/users/directory.client';
import { createTestApp } from './test-app.helper';

/**
 * E2E phân quyền endpoint sync (AC 5) — dùng seam AUTH_DEV_MODE (thiết kế 1.1):
 * header x-dev-role quyết định vai, KHÔNG cần DB/PMH ID (DirectoryClient override,
 * DirectorySyncService không được gọi tới ở case 401/403).
 */
const fakeDirectory: DirectoryClientApi = {
  fetchUsers: () => Promise.resolve([]),
  fetchGroups: () => Promise.resolve([{ id: 'g1', name: 'Developers' }]),
};

describe('POST /api/admin/directory-sync — phân quyền (AC 5)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true'; // NODE_ENV=test thuộc allowlist
    app = await createTestApp(
      [],
      [{ token: DIRECTORY_CLIENT, useValue: fakeDirectory }],
    );
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTH_DEV_MODE;
  });

  it('không đăng nhập → 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/admin/directory-sync')
      .expect(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('vai member → 403 FORBIDDEN_ROLE (server chặn, độc lập UI — NFR-7)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/admin/directory-sync')
      .set('x-dev-user-sub', 'member-1')
      .set('x-dev-role', 'member')
      .expect(403);
    expect(res.body.code).toBe('FORBIDDEN_ROLE');
  });

  it('vai admin → 403 (endpoint chỉ SA)', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/directory-sync')
      .set('x-dev-user-sub', 'admin-1')
      .set('x-dev-role', 'admin')
      .expect(403);
  });

  it('GET groups: member → 403; SA → 200 danh sách group (AC 3)', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/directory-sync/groups')
      .set('x-dev-user-sub', 'member-1')
      .set('x-dev-role', 'member')
      .expect(403);
    const res = await request(app.getHttpServer())
      .get('/api/admin/directory-sync/groups')
      .set('x-dev-user-sub', 'sa-1')
      .set('x-dev-role', 'sa')
      .expect(200);
    expect(res.body).toEqual([{ id: 'g1', name: 'Developers' }]);
  });
});
