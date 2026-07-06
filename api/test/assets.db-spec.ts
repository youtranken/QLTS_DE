import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

if (!process.env.DATABASE_URL) {
  throw new Error(
    '[assets.db-spec] DATABASE_URL chưa đặt — cần Postgres thật.',
  );
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[assets.db-spec] Từ chối chạy trên DB '${dbName}'.`);
}

describe('Sổ tài sản trên DB thật (story 2.1)', () => {
  let app: INestApplication;
  let pool: Pool;

  const asAdmin = () => ({
    'x-dev-user-sub': 'admin-t',
    'x-dev-role': 'admin',
  });

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name) VALUES
       ('sub-u1', 'u1@pmh.com.vn', 'Trần Thị Bình')`,
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('UNIQUE(code) tầng DB: 2 INSERT trùng mã → cái sau bị từ chối (AC 2)', async () => {
    await pool.query(
      "INSERT INTO assets (code, type) VALUES ('DUP-01', 'laptop')",
    );
    await expect(
      pool.query(
        "INSERT INTO assets (code, type) VALUES ('DUP-01', 'desktop')",
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'assets_code_key' });
  });

  it('tạo qua API: mặc định in_use + pool TẮT + version 1; audit assets.create (AC 1)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({
        code: '3-AA-CT-0042',
        type: 'laptop',
        configuration: 'i7/16GB/512GB',
        cost: 25000000,
        startDate: '2026-01-15',
        floor: '3',
        serial: 'SN-XYZ',
        brand: 'Dell',
        model: 'Latitude 5440',
        assignedUserSub: 'sub-u1',
        // client cố nhét status/isPool → whitelist strip, KHÔNG có đường vòng 2.6
        status: 'disposed',
        isPool: true,
      })
      .expect(201);
    expect(res.body).toMatchObject({
      code: '3-AA-CT-0042',
      status: 'in_use',
      isPool: false,
      version: 1,
    });
    const audit = await pool.query(
      "SELECT actor, object_id FROM audit_log WHERE action = 'assets.create'",
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor).toBe('admin-t');
  });

  it('tạo trùng mã qua API → 409 CODE_TAKEN (AC 1)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({ code: '3-AA-CT-0042', type: 'desktop' })
      .expect(409);
    expect(res.body.code).toBe('CODE_TAKEN');
  });

  it('người đứng tên không tồn tại → 400 ASSIGNEE_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({ code: 'FK-01', type: 'laptop', assignedUserSub: 'khong-co' })
      .expect(400);
    expect(res.body.code).toBe('ASSIGNEE_NOT_FOUND');
  });

  it('optimistic lock: 2 người cùng sửa → người sau 409 STALE_VERSION (AC 3)', async () => {
    const { rows } = await pool.query(
      "SELECT id FROM assets WHERE code = '3-AA-CT-0042'",
    );
    const id = rows[0].id as string;
    const form = {
      code: '3-AA-CT-0042',
      type: 'laptop',
      configuration: 'i7/16GB/512GB',
      cost: 25000000,
      startDate: '2026-01-15',
      floor: '3',
      serial: 'SN-XYZ',
      brand: 'Dell',
      model: 'Latitude 5440',
      assignedUserSub: 'sub-u1',
    };
    // người A sửa với version 1 → ok, version thành 2
    const okRes = await request(app.getHttpServer())
      .put(`/api/admin/assets/${id}`)
      .set(asAdmin())
      .send({ ...form, note: 'người A sửa', version: 1 })
      .expect(200);
    expect(okRes.body).toEqual({ ok: true, version: 2 });
    // người B vẫn cầm version 1 → 409
    const stale = await request(app.getHttpServer())
      .put(`/api/admin/assets/${id}`)
      .set(asAdmin())
      .send({ ...form, note: 'người B sửa', version: 1 })
      .expect(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    expect(stale.body.message).toContain('tải lại');
    // DB giữ bản của A
    const after = await pool.query(
      'SELECT note, version FROM assets WHERE id = $1',
      [id],
    );
    expect(after.rows[0]).toEqual({ note: 'người A sửa', version: 2 });
  });

  it('sửa ghi audit assets.update với changed from→to (FR-35)', async () => {
    const audit = await pool.query(
      "SELECT actor, detail FROM audit_log WHERE action = 'assets.update' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor).toBe('admin-t');
    expect(audit.rows[0].detail.changed).toMatchObject({
      note: { from: null, to: 'người A sửa' },
    });
  });

  it('sửa id không tồn tại → 404 ASSET_NOT_FOUND', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/admin/assets/2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f')
      .set(asAdmin())
      .send({ code: 'X-1', type: 'laptop', version: 1 })
      .expect(404);
    expect(res.body.code).toBe('ASSET_NOT_FOUND');
  });

  it('danh sách: phân trang server-side + join tên người đứng tên (AC 2, NFR-5)', async () => {
    // thêm dữ liệu để có nhiều trang
    for (let i = 1; i <= 5; i++) {
      await pool.query(
        `INSERT INTO assets (code, type, floor) VALUES ('PAGE-0${i}', 'monitor', '5')`,
      );
    }
    const page1 = await request(app.getHttpServer())
      .get('/api/admin/assets?page=1&pageSize=3')
      .set(asAdmin())
      .expect(200);
    expect(page1.body.items).toHaveLength(3);
    // DUP-01 + 3-AA-CT-0042 + PAGE-01..05 (FK-01 bị 400 nên không có row)
    expect(page1.body.total).toBe(7);
    const page2 = await request(app.getHttpServer())
      .get('/api/admin/assets?page=2&pageSize=3')
      .set(asAdmin())
      .expect(200);
    // không trùng bản ghi giữa 2 trang
    interface Row {
      id: string;
      code: string;
      assignedUserName: string | null;
    }
    const items1 = page1.body.items as Row[];
    const items2 = page2.body.items as Row[];
    const ids2 = new Set(items2.map((a) => a.id));
    expect(items1.filter((a) => ids2.has(a.id))).toHaveLength(0);
    // join tên người đứng tên
    const assigned = [...items1, ...items2].find(
      (a) => a.code === '3-AA-CT-0042',
    );
    expect(assigned?.assignedUserName).toBe('Trần Thị Bình');
  });

  it('chi tiết theo id: đủ trường FR-30 + version cho form sửa', async () => {
    const { rows } = await pool.query(
      "SELECT id FROM assets WHERE code = '3-AA-CT-0042'",
    );
    const res = await request(app.getHttpServer())
      .get(`/api/admin/assets/${rows[0].id}`)
      .set(asAdmin())
      .expect(200);
    expect(res.body).toMatchObject({
      code: '3-AA-CT-0042',
      type: 'laptop',
      cost: 25000000,
      startDate: '2026-01-15',
      assignedUserSub: 'sub-u1',
      assignedUserName: 'Trần Thị Bình',
      version: 2,
    });
  });

  it('CSRF phiên thật: POST assets bằng cookie thiếu X-CSRF-Token → 403 (review 2.1)', async () => {
    // admin qua phiên OIDC thật (không phải dev-header — CsrfGuard chỉ chạy nhánh này)
    await pool.query(
      "INSERT INTO users (sub, email, full_name, role) VALUES ('sub-adm-csrf', 'adm@pmh.com.vn', 'Admin CSRF', 'admin')",
    );
    const sid = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, user_sub, refresh_token, access_token_exp, claims, csrf_token)
       VALUES ($1, 'sub-adm-csrf', 'rt-x', now() + interval '5 minutes', $2, 'csrf-dung')`,
      [sid, JSON.stringify({ sub: 'sub-adm-csrf' })],
    );
    const res = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set('Cookie', `qlts_sid=${sid}`)
      .send({ code: 'CSRF-01', type: 'laptop' })
      .expect(403);
    expect(res.body.code).toBe('CSRF_TOKEN_INVALID');
    // kèm token đúng → đi qua CSRF, tạo thành công
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set('Cookie', `qlts_sid=${sid}`)
      .set('X-CSRF-Token', 'csrf-dung')
      .send({ code: 'CSRF-01', type: 'laptop' })
      .expect(201);
  });

  it('tìm & lọc server-side: theo mã, theo tên người, kết hợp, count đúng, rỗng (story 2.2)', async () => {
    // dữ liệu hiện có: DUP-01 (laptop), 3-AA-CT-0042 (laptop, Trần Thị Bình, tầng 3),
    // PAGE-01..05 (monitor, tầng 5), CSRF-01 (laptop)
    const get = (qs: string) =>
      request(app.getHttpServer())
        .get(`/api/admin/assets?${qs}`)
        .set(asAdmin())
        .expect(200);

    // theo mã (một phần, không phân biệt hoa thường)
    const byCode = await get('search=aa-ct');
    expect(byCode.body.total).toBe(1);
    expect(byCode.body.items[0].code).toBe('3-AA-CT-0042');

    // theo tên người đứng tên
    const byName = await get('search=Bình');
    expect(byName.body.total).toBe(1);
    expect(byName.body.items[0].code).toBe('3-AA-CT-0042');

    // ký tự wildcard bị escape — '%' không khớp tất cả
    const wildcard = await get('search=%25');
    expect(wildcard.body.total).toBe(0);

    // '_' phải là literal, không phải khớp-1-ký-tự (DUP_0 KHÔNG khớp DUP-0x)
    const underscore = await get('search=DUP_0');
    expect(underscore.body.total).toBe(0);

    // lọc kết hợp type + floor; count áp CÙNG bộ lọc (không phải tổng bảng)
    const combo = await get('type=monitor&floor=5&pageSize=2');
    expect(combo.body.total).toBe(5);
    expect(combo.body.items).toHaveLength(2);

    // status kết hợp: lọc đúng (PAGE-* default in_use) và loại trừ đúng
    const withStatus = await get('type=monitor&floor=5&status=in_use');
    expect(withStatus.body.total).toBe(5);
    const excluded = await get('type=monitor&floor=5&status=locked_repair');
    expect(excluded.body.total).toBe(0);

    // search + lọc kết hợp
    const searchCombo = await get('search=PAGE&type=monitor');
    expect(searchCombo.body.total).toBe(5);

    // không khớp → rỗng, không lỗi
    const none = await get('search=khong-ton-tai-9999');
    expect(none.body.total).toBe(0);
    expect(none.body.items).toEqual([]);
  });

  it('meta trả distinct loại + tầng cho dropdown (story 2.2)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/assets/meta')
      .set(asAdmin())
      .expect(200);
    expect(res.body.types).toEqual(
      expect.arrayContaining(['laptop', 'monitor']),
    );
    expect(res.body.floors).toEqual(expect.arrayContaining(['3', '5']));
    // không có null trong floors
    expect(res.body.floors).not.toContain(null);
  });

  it('CHECK constraint status: giá trị lạ bị DB từ chối (nền 2.6)', async () => {
    await expect(
      pool.query(
        "INSERT INTO assets (code, type, status) VALUES ('BAD-ST', 'laptop', 'dang_bay')",
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
