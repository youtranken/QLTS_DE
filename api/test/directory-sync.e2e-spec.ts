import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DIRECTORY_CLIENT } from '../src/modules/users/directory.client';
import type { DirectoryClientApi } from '../src/modules/users/directory.client';
import { DirectorySyncService } from '../src/modules/users/directory-sync.service';
import { createTestApp } from './test-app.helper';

/**
 * E2E phân quyền endpoint sync (AC 5) — dùng seam AUTH_DEV_MODE (thiết kế 1.1):
 * header x-dev-role quyết định vai, KHÔNG cần DB/PMH ID (DirectoryClient +
 * DirectorySyncService đều override — case được-phép mới chạm tới service).
 */
const fakeDirectory: DirectoryClientApi = {
  fetchUsers: () => Promise.resolve([]),
  fetchGroups: () => Promise.resolve([{ id: 'g1', name: 'Developers' }]),
};

// Vai được phép đi qua guard sẽ gọi thật service (cần DB) — stub để test đúng
// phần phân quyền, không kéo theo hạ tầng.
const fakeSync = { sync: () => Promise.resolve({ created: 0, updated: 0 }) };

describe('POST /api/admin/directory-sync — phân quyền (AC 5)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true'; // NODE_ENV=test thuộc allowlist
    app = await createTestApp(
      [],
      [
        { token: DIRECTORY_CLIENT, useValue: fakeDirectory },
        { token: DirectorySyncService, useValue: fakeSync },
      ],
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

  // Delegation 10.1: Admin ĐƯỢC phép sync (@Roles cấp class ở users.controller.ts:18).
  // Test cũ khẳng định "chỉ SA" — sai so với chính sách hiện hành, sửa 2026-07-19.
  it('vai admin → 200 (delegation 10.1: SA + Admin đều sync được)', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/directory-sync')
      .set('x-dev-user-sub', 'admin-1')
      .set('x-dev-role', 'admin')
      .expect(200);
  });

  it('vai sa → 200', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/directory-sync')
      .set('x-dev-user-sub', 'sa-1')
      .set('x-dev-role', 'sa')
      .expect(200);
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
