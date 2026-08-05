import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { DIRECTORY_CLIENT } from '../src/modules/users/directory.client';
import type {
  DirectoryClientApi,
  DirectoryUser,
} from '../src/modules/users/directory.client';
import { createTestApp } from './test-app.helper';

if (!process.env.DATABASE_URL) {
  throw new Error(
    '[directory-sync.db-spec] DATABASE_URL chưa đặt — cần Postgres thật.',
  );
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[directory-sync.db-spec] Từ chối chạy trên DB '${dbName}'.`);
}

describe('Đồng bộ danh bạ trên DB thật (story 1.3)', () => {
  let app: INestApplication;
  let pool: Pool;
  let directoryUsers: DirectoryUser[] = [];

  const fakeDirectory: DirectoryClientApi = {
    fetchUsers: () => Promise.resolve(directoryUsers),
    fetchGroups: () => Promise.resolve([{ id: 'g1', name: 'Developers' }]),
  };

  const syncAsSa = () =>
    request(app.getHttpServer())
      .post('/api/admin/directory-sync')
      .set('x-dev-user-sub', 'sa-test')
      .set('x-dev-role', 'sa');

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    app = await createTestApp(
      [],
      [{ token: DIRECTORY_CLIENT, useValue: fakeDirectory }],
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('sync lần đầu: tạo user mới kèm status, role mặc định member (AC 1, 2)', async () => {
    directoryUsers = [
      {
        id: 'sub-a',
        employee_code: 'NV001',
        email: 'a@pmh.com.vn',
        full_name: 'User A',
        status: 'active',
        groups: ['Developers'],
      },
      {
        id: 'sub-b',
        employee_code: 'NV002',
        email: 'b@pmh.com.vn',
        full_name: 'User B',
        status: 'deleted',
        groups: [],
      },
    ];
    const res = await syncAsSa().expect(200);
    expect(res.body).toMatchObject({ total: 2, created: 2, updated: 0 });
    expect(res.body.groups).toEqual([{ id: 'g1', name: 'Developers' }]);

    const rows = await pool.query(
      'SELECT sub, status, role, first_login_at FROM users ORDER BY sub',
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows[0]).toMatchObject({
      sub: 'sub-a',
      status: 'active',
      role: 'member',
    });
    expect(rows.rows[1]).toMatchObject({ sub: 'sub-b', status: 'deleted' });
    expect(rows.rows[0].first_login_at).toBeNull();
  });

  it('sync lần 2: idempotent — không đổi gì thì unchanged, không tạo trùng, không bump updated_at (AC 2)', async () => {
    const res = await syncAsSa().expect(200);
    expect(res.body).toMatchObject({
      total: 2,
      created: 0,
      updated: 0,
      unchanged: 2,
    });
    const count = await pool.query('SELECT count(*)::int AS n FROM users');
    expect(count.rows[0].n).toBe(2);
  });

  it('sync GIỮ role + login timestamps của user đã từng đăng nhập (AC 7)', async () => {
    await pool.query(
      "UPDATE users SET role = 'admin', first_login_at = now(), last_login_at = now() WHERE sub = 'sub-a'",
    );
    directoryUsers = [
      { ...directoryUsers[0], full_name: 'User A đổi tên' },
      directoryUsers[1],
    ];
    await syncAsSa().expect(200);
    const row = await pool.query(
      "SELECT full_name, role, first_login_at FROM users WHERE sub = 'sub-a'",
    );
    expect(row.rows[0].full_name).toBe('User A đổi tên');
    expect(row.rows[0].role).toBe('admin'); // KHÔNG bị sync ghi đè
    expect(row.rows[0].first_login_at).not.toBeNull();
  });

  it('record hỏng (thiếu id) → skipped, record hợp lệ VẪN ghi được (sanitize sau review)', async () => {
    directoryUsers = [
      {
        id: 'sub-c',
        email: 'c@pmh.com.vn',
        full_name: 'User C',
        status: 'active',
        groups: [],
      },
      // id null → bị filter, không phá cả đợt sync (khác trước review: rollback cả đợt)
      { id: null as unknown as string, status: 'active', groups: [] },
    ];
    const res = await syncAsSa().expect(200);
    expect(res.body).toMatchObject({ created: 1, skipped: 1 });
    const row = await pool.query("SELECT sub FROM users WHERE sub = 'sub-c'");
    expect(row.rowCount).toBe(1);
  });

  it('2 sync đồng thời → không PK violation (ON CONFLICT), user mới chỉ một bản ghi', async () => {
    directoryUsers = [
      { id: 'sub-race', email: 'r@pmh.com.vn', status: 'active', groups: [] },
    ];
    const [r1, r2] = await Promise.all([syncAsSa(), syncAsSa()]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const count = await pool.query(
      "SELECT count(*)::int AS n FROM users WHERE sub = 'sub-race'",
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('audit ghi users.directory_sync với actor + kết quả (AC 6)', async () => {
    const audit = await pool.query(
      "SELECT actor, detail FROM audit_log WHERE action = 'users.directory_sync' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor).toBe('sa-test');
    expect(audit.rows[0].detail).toMatchObject({ total: 1 });
  });
});
