import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { DRIZZLE_DB } from '../src/database/database.module';
import type { Database } from '../src/database/database.module';
import { AssetsService } from '../src/modules/assets/assets.service';
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

/**
 * ⚠️ FILE NÀY LÀ CHUỖI TRẠNG THÁI (test sau dựa dữ liệu test trước — có chủ đích
 * để test cascade xuyên story). QUY ƯỚC: test mới CHỈ APPEND CUỐI FILE, dùng
 * prefix code riêng, KHÔNG đụng fixture chung (DUP-01/PAGE-0x/SW-01/3-AA-CT-0042).
 * Epic 3 mở file db-spec MỚI, không chèn vào đây.
 */
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
      'DROP TABLE IF EXISTS outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
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
    // scope theo object_id — miễn nhiễm test mới thêm asset (epic review)
    const audit = await pool.query(
      "SELECT actor FROM audit_log WHERE action = 'assets.create' AND object_id = $1",
      [res.body.id],
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

  it('sắp xếp server-side theo cột whitelist + hướng; giá trị lạ → 400 (P1)', async () => {
    const asc = await request(app.getHttpServer())
      .get('/api/admin/assets?page=1&pageSize=100&sort=code&dir=asc')
      .set(asAdmin())
      .expect(200);
    const codesAsc = (asc.body.items as { code: string }[]).map((a) => a.code);
    const desc = await request(app.getHttpServer())
      .get('/api/admin/assets?page=1&pageSize=100&sort=code&dir=desc')
      .set(asAdmin())
      .expect(200);
    const codesDesc = (desc.body.items as { code: string }[]).map((a) => a.code);
    // desc là đảo ngược asc (cùng collation PG cả 2 chiều) → chứng minh dir đổi hướng thật
    expect(codesDesc).toEqual([...codesAsc].reverse());
    expect(codesAsc.length).toBeGreaterThan(1);
    // sort ngoài whitelist → 400 (chặn injection qua tên cột)
    await request(app.getHttpServer())
      .get('/api/admin/assets?sort=code;DROP%20TABLE&dir=asc')
      .set(asAdmin())
      .expect(400);
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

  it('meta trả distinct loại cho dropdown (story 2.2; Tầng gỡ ở 7.6)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/admin/assets/meta')
      .set(asAdmin())
      .expect(200);
    expect(res.body.types).toEqual(
      expect.arrayContaining(['laptop', 'monitor']),
    );
    // 7.6: meta không còn floors
    expect(res.body.floors).toBeUndefined();
  });

  it('lịch sử cấp phát (2.3): seed khi tạo → đổi người → thu hồi; không đổi → không thêm row', async () => {
    const { rows } = await pool.query(
      "SELECT id, version FROM assets WHERE code = '3-AA-CT-0042'",
    );
    const id = rows[0].id as string;
    const version = rows[0].version as number;

    // seed từ create (from NULL → sub-u1); update trước đó KHÔNG đổi người → vẫn 1 row
    const seed = await pool.query(
      'SELECT from_user_sub, to_user_sub, actor FROM allocation_history WHERE asset_id = $1 ORDER BY created_at',
      [id],
    );
    expect(seed.rowCount).toBe(1);
    expect(seed.rows[0]).toEqual({
      from_user_sub: null,
      to_user_sub: 'sub-u1',
      actor: 'admin-t',
    });

    await pool.query(
      "INSERT INTO users (sub, full_name) VALUES ('sub-u2', 'Lê Văn Cường')",
    );
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
      note: 'người A sửa',
    };
    // đổi sub-u1 → sub-u2 kèm ghi chú cấp phát
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${id}`)
      .set(asAdmin())
      .send({
        ...form,
        assignedUserSub: 'sub-u2',
        allocationNote: 'bàn giao kèm sạc',
        version,
      })
      .expect(200);
    // thu hồi về kho (bỏ trống)
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${id}`)
      .set(asAdmin())
      .send({ ...form, version: version + 1 })
      .expect(200);

    // API trả GIẢM dần theo thời gian, join đủ tên from/to/actor
    const res = await request(app.getHttpServer())
      .get(`/api/admin/assets/${id}/allocations`)
      .set(asAdmin())
      .expect(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0]).toMatchObject({
      fromUserSub: 'sub-u2',
      fromUserName: 'Lê Văn Cường',
      toUserSub: null,
      note: null,
    });
    expect(res.body[1]).toMatchObject({
      fromUserSub: 'sub-u1',
      fromUserName: 'Trần Thị Bình',
      toUserSub: 'sub-u2',
      toUserName: 'Lê Văn Cường',
      note: 'bàn giao kèm sạc',
    });
    expect(res.body[2]).toMatchObject({
      fromUserSub: null,
      toUserSub: 'sub-u1',
    });
  });

  it('allocation_history: FK chặn asset ma; UPDATE/DELETE bị trigger DB từ chối (2.3)', async () => {
    await expect(
      pool.query(
        "INSERT INTO allocation_history (asset_id, actor) VALUES (gen_random_uuid(), 'x')",
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // append-only tầng DB (tiền lệ AD-10) — không tin logic app
    await expect(
      pool.query("UPDATE allocation_history SET note = 'sua vet'"),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM allocation_history')).rejects.toThrow(
      /append-only/,
    );
  });

  it('FR-31: máy đang cấp phát vẫn bật cờ pool được — tầng DB không chặn (2.3)', async () => {
    await pool.query(
      "UPDATE assets SET assigned_user_sub = 'sub-u1', is_pool = true WHERE code = 'DUP-01'",
    );
    const row = await pool.query(
      "SELECT assigned_user_sub, is_pool FROM assets WHERE code = 'DUP-01'",
    );
    expect(row.rows[0]).toEqual({ assigned_user_sub: 'sub-u1', is_pool: true });
  });

  it('software (2.4): validate license, gắn máy khi tạo, GET :id/software', async () => {
    const machine = await pool.query(
      "SELECT id FROM assets WHERE code = 'DUP-01'",
    );
    const machineId = machine.rows[0].id as string;

    // term thiếu hạn → 400
    const noEnd = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({
        code: 'SW-01',
        type: 'software',
        licenseName: 'Autocad',
        licenseType: 'term',
      })
      .expect(400);
    expect(noEnd.body.code).toBe('LICENSE_END_DATE_REQUIRED');

    // perpetual thiếu tên → 400
    const noName = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({ code: 'SW-01', type: 'software', licenseType: 'perpetual' })
      .expect(400);
    expect(noName.body.code).toBe('LICENSE_NAME_REQUIRED');

    // hợp lệ: term + hạn, gắn máy DUP-01 khi tạo
    const sw = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({
        code: 'SW-01',
        type: 'software',
        licenseName: 'Autocad',
        licenseType: 'term',
        endDate: '2027-06-30',
        installedOnAssetId: machineId,
      })
      .expect(201);
    expect(sw.body).toMatchObject({
      type: 'software',
      licenseType: 'term',
      installedOnAssetId: machineId,
      isPool: false,
    });

    // gắn software vào software → 400
    const onSw = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({
        code: 'SW-02',
        type: 'software',
        licenseType: 'perpetual',
        licenseName: 'Office LTSC',
        installedOnAssetId: sw.body.id,
      })
      .expect(400);
    expect(onSw.body.code).toBe('INSTALL_ON_SOFTWARE');

    // gắn vào máy thanh lý → 409
    await pool.query(
      "INSERT INTO assets (code, type, status) VALUES ('DEAD-01', 'desktop', 'disposed')",
    );
    const dead = await pool.query(
      "SELECT id FROM assets WHERE code = 'DEAD-01'",
    );
    const onDead = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({
        code: 'SW-02',
        type: 'software',
        licenseType: 'perpetual',
        licenseName: 'Office LTSC',
        installedOnAssetId: dead.rows[0].id,
      })
      .expect(409);
    expect(onDead.body.code).toBe('INSTALL_TARGET_DISPOSED');

    // "chưa gắn máy" là trạng thái HỢP LỆ (FR-37) — tạo đứng một mình thành công
    const detached = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({
        code: 'SW-02',
        type: 'software',
        licenseType: 'perpetual',
        licenseName: 'Office LTSC',
      })
      .expect(201);
    expect(detached.body.installedOnAssetId).toBeNull();

    // GET :id/software liệt kê đúng bản ghi đang trỏ vào máy (AC 2)
    const list = await request(app.getHttpServer())
      .get(`/api/admin/assets/${machineId}/software`)
      .set(asAdmin())
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({
      code: 'SW-01',
      licenseType: 'term',
      endDate: '2027-06-30',
    });

    // đổi type software → laptop qua form sửa → 400 (AC 3, software-ness bất biến)
    const flip = await request(app.getHttpServer())
      .put(`/api/admin/assets/${sw.body.id}`)
      .set(asAdmin())
      .send({ code: 'SW-01', type: 'laptop', version: 1 })
      .expect(400);
    expect(flip.body.code).toBe('TYPE_SOFTWARE_IMMUTABLE');
  });

  it('software (2.4): CHECK tầng DB chặn mọi đường vòng (pool, license fields lạc chỗ)', async () => {
    // software bật pool → 23514
    await expect(
      pool.query(
        "INSERT INTO assets (code, type, license_type, end_date, is_pool) VALUES ('SW-P', 'software', 'term', '2027-01-01', true)",
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // non-software mang license_type → 23514
    await expect(
      pool.query(
        "INSERT INTO assets (code, type, license_type) VALUES ('LT-X', 'laptop', 'term')",
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // software không có license_type → 23514
    await expect(
      pool.query("INSERT INTO assets (code, type) VALUES ('SW-X', 'software')"),
    ).rejects.toMatchObject({ code: '23514' });
    // perpetual có end_date → 23514
    await expect(
      pool.query(
        "INSERT INTO assets (code, type, license_type, license_name, end_date) VALUES ('SW-Y', 'software', 'perpetual', 'X', '2027-01-01')",
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('chuyển license (2.5): A→B đổi FK + audit + GET software 2 máy; gỡ về null; các nhánh lỗi', async () => {
    const sw = await pool.query(
      "SELECT id, version FROM assets WHERE code = 'SW-01'",
    );
    const swId = sw.rows[0].id as string;
    let version = sw.rows[0].version as number;
    const mayA = (
      await pool.query("SELECT id FROM assets WHERE code = 'DUP-01'")
    ).rows[0].id as string;
    const mayB = (
      await pool.query("SELECT id FROM assets WHERE code = 'PAGE-01'")
    ).rows[0].id as string;
    const dead = (
      await pool.query("SELECT id FROM assets WHERE code = 'DEAD-01'")
    ).rows[0].id as string;

    // A→B: FK đổi, audit from→to, GET software phản ánh cả 2 máy
    const moved = await request(app.getHttpServer())
      .put(`/api/admin/assets/${swId}/transfer`)
      .set(asAdmin())
      .send({ targetAssetId: mayB, version })
      .expect(200);
    version = moved.body.version as number;
    const listA = await request(app.getHttpServer())
      .get(`/api/admin/assets/${mayA}/software`)
      .set(asAdmin())
      .expect(200);
    expect(listA.body).toHaveLength(0);
    const listB = await request(app.getHttpServer())
      .get(`/api/admin/assets/${mayB}/software`)
      .set(asAdmin())
      .expect(200);
    const listBItems = listB.body as Array<{ code: string }>;
    expect(listBItems.map((s) => s.code)).toEqual(['SW-01']);
    const audit = await pool.query(
      "SELECT detail FROM audit_log WHERE action = 'assets.license_transfer' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.rows[0].detail).toEqual({ from: mayA, to: mayB });

    // đích thanh lý → 409, FK giữ nguyên
    const toDead = await request(app.getHttpServer())
      .put(`/api/admin/assets/${swId}/transfer`)
      .set(asAdmin())
      .send({ targetAssetId: dead, version })
      .expect(409);
    expect(toDead.body.code).toBe('INSTALL_TARGET_DISPOSED');

    // version cũ → 409 STALE
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${swId}/transfer`)
      .set(asAdmin())
      .send({ version: version - 1 })
      .expect(409);

    // nguồn không phải software → 400 NOT_SOFTWARE
    const notSw = await request(app.getHttpServer())
      .put(`/api/admin/assets/${mayA}/transfer`)
      .set(asAdmin())
      .send({ version: 1 })
      .expect(400);
    expect(notSw.body.code).toBe('NOT_SOFTWARE');

    // gỡ về "chưa gắn máy"
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${swId}/transfer`)
      .set(asAdmin())
      .send({ version })
      .expect(200);
    const detached = await pool.query(
      'SELECT installed_on_asset_id FROM assets WHERE id = $1',
      [swId],
    );
    expect(detached.rows[0].installed_on_asset_id).toBeNull();
  });

  it('cảnh báo đỏ (2.5): đủ 4 nhánh + đổi hạn là hết đỏ ngay (FR-29/38)', async () => {
    const mayB = (
      await pool.query("SELECT id FROM assets WHERE code = 'PAGE-01'")
    ).rows[0].id as string;
    // license term còn 10 ngày, gắn máy sống → ĐỎ
    await pool.query(
      `INSERT INTO assets (code, type, license_type, end_date, installed_on_asset_id)
       VALUES ('SW-RED', 'software', 'term', CURRENT_DATE + 10, $1)`,
      [mayB],
    );
    // term còn 10 ngày nhưng CHƯA gắn máy → không đỏ
    await pool.query(
      `INSERT INTO assets (code, type, license_type, end_date)
       VALUES ('SW-FLOAT', 'software', 'term', CURRENT_DATE + 10)`,
    );
    // term còn 10 ngày gắn máy THANH LÝ → không đỏ
    const dead = (
      await pool.query("SELECT id FROM assets WHERE code = 'DEAD-01'")
    ).rows[0].id as string;
    await pool.query(
      `INSERT INTO assets (code, type, license_type, end_date, installed_on_asset_id)
       VALUES ('SW-DEADHOST', 'software', 'term', CURRENT_DATE + 10, $1)`,
      [dead],
    );
    // term còn XA (100 ngày) gắn máy sống → không đỏ
    await pool.query(
      `INSERT INTO assets (code, type, license_type, end_date, installed_on_asset_id)
       VALUES ('SW-FAR', 'software', 'term', CURRENT_DATE + 100, $1)`,
      [mayB],
    );
    // ĐÃ hết hạn (quá 5 ngày) gắn máy sống → vẫn đỏ ("còn ≤N ngày" bao gồm quá hạn)
    await pool.query(
      `INSERT INTO assets (code, type, license_type, end_date, installed_on_asset_id)
       VALUES ('SW-EXPIRED', 'software', 'term', CURRENT_DATE - 5, $1)`,
      [mayB],
    );
    const res = await request(app.getHttpServer())
      .get('/api/admin/assets?search=SW-&pageSize=50')
      .set(asAdmin())
      .expect(200);
    const byCode = new Map(
      (res.body.items as Array<{ code: string; licenseWarning: boolean }>).map(
        (a) => [a.code, a.licenseWarning],
      ),
    );
    expect(byCode.get('SW-RED')).toBe(true);
    expect(byCode.get('SW-EXPIRED')).toBe(true);
    expect(byCode.get('SW-FLOAT')).toBe(false);
    expect(byCode.get('SW-DEADHOST')).toBe(false);
    expect(byCode.get('SW-FAR')).toBe(false);
    // máy thường không bao giờ đỏ dù end_date gần (cột dùng chung — defer 2.4)
    const machines = await request(app.getHttpServer())
      .get('/api/admin/assets?search=DUP-01')
      .set(asAdmin())
      .expect(200);
    expect(machines.body.items[0].licenseWarning).toBe(false);

    // FR-29: cập nhật hạn mới → hết cảnh báo NGAY
    await pool.query(
      "UPDATE assets SET end_date = CURRENT_DATE + 365 WHERE code = 'SW-RED'",
    );
    const after = await request(app.getHttpServer())
      .get('/api/admin/assets?search=SW-RED')
      .set(asAdmin())
      .expect(200);
    expect(after.body.items[0].licenseWarning).toBe(false);
  });

  it('detachAllFrom (2.5→2.6): gỡ mọi license khỏi máy + 1 audit danh sách mã', async () => {
    const mayB = (
      await pool.query("SELECT id FROM assets WHERE code = 'PAGE-01'")
    ).rows[0].id as string;
    // SW-RED + SW-FAR + SW-EXPIRED đang gắn PAGE-01 (test trước)
    const svc = app.get(AssetsService);
    const codes = await svc.detachAllFrom(
      app.get<Database>(DRIZZLE_DB),
      mayB,
      'sa-t',
    );
    expect(codes.sort()).toEqual(['SW-EXPIRED', 'SW-FAR', 'SW-RED']);
    const left = await pool.query(
      'SELECT count(*)::int AS n FROM assets WHERE installed_on_asset_id = $1',
      [mayB],
    );
    expect(left.rows[0].n).toBe(0);
    const audit = await pool.query(
      "SELECT detail FROM audit_log WHERE action = 'assets.license_detach_all'",
    );
    expect(audit.rowCount).toBe(1);
    expect((audit.rows[0].detail.detached as string[]).sort()).toEqual([
      'SW-EXPIRED',
      'SW-FAR',
      'SW-RED',
    ]);
  });

  it('vòng đời (2.6): pool → khóa (note+ETA, pool GIỮ) → mở khóa (pool như trước) + guards', async () => {
    const may = (
      await pool.query("SELECT id FROM assets WHERE code = 'PAGE-02'")
    ).rows[0].id as string;

    // bật pool (version 1 → 2), status không đổi
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${may}/pool`)
      .set(asAdmin())
      .send({ isPool: true, version: 1 })
      .expect(200);
    let row = await pool.query(
      'SELECT status, is_pool, version FROM assets WHERE id = $1',
      [may],
    );
    expect(row.rows[0]).toEqual({
      status: 'in_use',
      is_pool: true,
      version: 2,
    });

    // khóa: BẮT BUỘC lý do + ETA vào asset_note; pool GIỮ NGUYÊN
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${may}/lock`)
      .set(asAdmin())
      .send({ reason: 'Hỏng màn hình', eta: '2026-08-01', version: 2 })
      .expect(200);
    row = await pool.query(
      'SELECT status, is_pool, version FROM assets WHERE id = $1',
      [may],
    );
    expect(row.rows[0]).toEqual({
      status: 'locked_repair',
      is_pool: true,
      version: 3,
    });
    const note = await pool.query(
      "SELECT kind, note, eta::text AS eta, actor FROM asset_note WHERE asset_id = $1 AND kind = 'lock'",
      [may],
    );
    expect(note.rows[0]).toEqual({
      kind: 'lock',
      note: 'Hỏng màn hình',
      eta: '2026-08-01',
      actor: 'admin-t',
    });
    const auditLock = await pool.query(
      "SELECT detail FROM audit_log WHERE action = 'assets.lock'",
    );
    expect(auditLock.rows[0].detail).toMatchObject({
      reason: 'Hỏng màn hình',
      from_status: 'in_use',
    });

    // khóa máy đã khóa → 409 INVALID_STATE; version cũ → 409 STALE
    const relock = await request(app.getHttpServer())
      .post(`/api/admin/assets/${may}/lock`)
      .set(asAdmin())
      .send({ reason: 'x', version: 3 })
      .expect(409);
    expect(relock.body.code).toBe('INVALID_STATE');
    const staleUnlock = await request(app.getHttpServer())
      .post(`/api/admin/assets/${may}/unlock`)
      .set(asAdmin())
      .send({ version: 1 })
      .expect(409);
    expect(staleUnlock.body.code).toBe('STALE_VERSION');

    // mở khóa → in_use, pool NHƯ TRƯỚC khi khóa (vẫn true)
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${may}/unlock`)
      .set(asAdmin())
      .send({ version: 3 })
      .expect(200);
    row = await pool.query('SELECT status, is_pool FROM assets WHERE id = $1', [
      may,
    ]);
    expect(row.rows[0]).toEqual({ status: 'in_use', is_pool: true });
    const unlockNote = await pool.query(
      "SELECT count(*)::int AS n FROM asset_note WHERE asset_id = $1 AND kind = 'unlock'",
      [may],
    );
    expect(unlockNote.rows[0].n).toBe(1);

    // pool cho software → 400; lock software → 400
    const sw = (
      await pool.query("SELECT id, version FROM assets WHERE code = 'SW-01'")
    ).rows[0];
    const poolSw = await request(app.getHttpServer())
      .put(`/api/admin/assets/${sw.id}/pool`)
      .set(asAdmin())
      .send({ isPool: true, version: sw.version })
      .expect(400);
    expect(poolSw.body.code).toBe('NOT_MACHINE');

    // AC 4: audit đủ CẢ 4 thao tác — unlock + pool_change (review 2.6)
    const auditPool = await pool.query(
      "SELECT detail FROM audit_log WHERE action = 'assets.pool_change'",
    );
    expect(auditPool.rows[0].detail).toMatchObject({ from: false, to: true });
    const auditUnlock = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'assets.unlock'",
    );
    expect(auditUnlock.rows[0].n).toBe(1);

    // asset_note append-only tầng DB (0014, tiền lệ AD-10)
    await expect(
      pool.query("UPDATE asset_note SET note = 'sua vet'"),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM asset_note')).rejects.toThrow(
      /append-only/,
    );
  });

  it('thanh lý (2.6): cascade license hết đỏ end-to-end, TERMINAL, vẫn trong danh sách', async () => {
    // máy mới + license term sắp hết hạn gắn vào → đỏ
    const may = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({ code: 'M-DISP', type: 'desktop' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({
        code: 'SW-DISP',
        type: 'software',
        licenseName: 'Autocad',
        licenseType: 'term',
        endDate: '2026-07-10',
        installedOnAssetId: may.body.id,
      })
      .expect(201);
    const red = await request(app.getHttpServer())
      .get('/api/admin/assets?search=SW-DISP')
      .set(asAdmin())
      .expect(200);
    // 7.7: search theo mã software trả cả máy host — chọn đúng dòng software theo code
    const redItems = red.body.items as Array<{
      code: string;
      licenseWarning: boolean;
    }>;
    expect(redItems.find((a) => a.code === 'SW-DISP')?.licenseWarning).toBe(
      true,
    );

    // thanh lý máy → license TỰ GỠ → hết đỏ NGAY; note + audit đủ
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${may.body.id}/dispose`)
      .set(asAdmin())
      .send({ version: 1 })
      .expect(200);
    const after = await request(app.getHttpServer())
      .get('/api/admin/assets?search=SW-DISP')
      .set(asAdmin())
      .expect(200);
    const afterItems = after.body.items as Array<{
      code: string;
      licenseWarning: boolean;
    }>;
    expect(afterItems.find((a) => a.code === 'SW-DISP')?.licenseWarning).toBe(
      false,
    );
    const detached = await pool.query(
      "SELECT installed_on_asset_id FROM assets WHERE code = 'SW-DISP'",
    );
    expect(detached.rows[0].installed_on_asset_id).toBeNull();
    const auditDispose = await pool.query(
      "SELECT detail FROM audit_log WHERE action = 'assets.dispose' ORDER BY created_at DESC LIMIT 1",
    );
    expect(auditDispose.rows[0].detail).toMatchObject({
      detached: ['SW-DISP'],
    });

    // KHÔNG ẩn khỏi danh sách — lọc status=disposed thấy M-DISP
    const disposedList = await request(app.getHttpServer())
      .get('/api/admin/assets?status=disposed&pageSize=50')
      .set(asAdmin())
      .expect(200);
    expect(
      (disposedList.body.items as Array<{ code: string }>).map((a) => a.code),
    ).toContain('M-DISP');

    // TERMINAL: dispose/lock/pool trên máy đã thanh lý → 409
    for (const [method, path, body] of [
      ['post', 'dispose', { version: 2 }],
      ['post', 'lock', { reason: 'x', version: 2 }],
      ['put', 'pool', { isPool: true, version: 2 }],
    ] as const) {
      const res = await request(app.getHttpServer())
        [method](`/api/admin/assets/${may.body.id}/${path}`)
        .set(asAdmin())
        .send(body)
        .expect(409);
      expect(res.body.code).toBe('INVALID_STATE');
    }

    // dispose máy pool → cờ pool được GỠ (không kẹt vĩnh viễn — review 2.6)
    const disposedPool = await pool.query(
      "SELECT is_pool FROM assets WHERE code = 'M-DISP'",
    );
    expect(disposedPool.rows[0].is_pool).toBe(false);

    // thanh lý SOFTWARE đang gắn máy → tự gỡ + disposed
    const sw2 = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({
        code: 'SW-DISP2',
        type: 'software',
        licenseType: 'perpetual',
        licenseName: 'X',
        installedOnAssetId: (
          await pool.query("SELECT id FROM assets WHERE code = 'PAGE-03'")
        ).rows[0].id,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${sw2.body.id}/dispose`)
      .set(asAdmin())
      .send({ version: 1 })
      .expect(200);
    const sw2After = await pool.query(
      "SELECT status, installed_on_asset_id, version FROM assets WHERE code = 'SW-DISP2'",
    );
    expect(sw2After.rows[0]).toMatchObject({
      status: 'disposed',
      installed_on_asset_id: null,
    });

    // TERMINAL kín (review 2.6 HIGH): software disposed KHÔNG "hồi sinh" qua transfer
    const mayLive = (
      await pool.query("SELECT id FROM assets WHERE code = 'PAGE-04'")
    ).rows[0].id as string;
    const resurrect = await request(app.getHttpServer())
      .put(`/api/admin/assets/${sw2.body.id}/transfer`)
      .set(asAdmin())
      .send({
        targetAssetId: mayLive,
        version: sw2After.rows[0].version as number,
      })
      .expect(409);
    expect(resurrect.body.code).toBe('INVALID_STATE');
    const still = await pool.query(
      "SELECT installed_on_asset_id FROM assets WHERE code = 'SW-DISP2'",
    );
    expect(still.rows[0].installed_on_asset_id).toBeNull();
  });

  it('GET :id/notes (2.7): lịch sử note desc + TÊN người ghi (lý do khóa + ETA từ 2.6)', async () => {
    // actor 'admin-t' phải có trong users để chứng minh join actorName (review 2.7)
    await pool.query(
      "INSERT INTO users (sub, full_name) VALUES ('admin-t', 'Quản Trị Viên') ON CONFLICT (sub) DO NOTHING",
    );
    const may = (
      await pool.query("SELECT id FROM assets WHERE code = 'PAGE-02'")
    ).rows[0].id as string;
    const res = await request(app.getHttpServer())
      .get(`/api/admin/assets/${may}/notes`)
      .set(asAdmin())
      .expect(200);
    // PAGE-02 đã qua chu kỳ khóa → mở khóa (test 2.6): unlock mới nhất đứng trước
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      kind: 'unlock',
      note: null,
      actorName: 'Quản Trị Viên',
    });
    expect(res.body[1]).toMatchObject({
      kind: 'lock',
      note: 'Hỏng màn hình',
      eta: '2026-08-01',
      actor: 'admin-t',
      actorName: 'Quản Trị Viên',
    });
  });

  it('export Excel (2.10): đúng dòng theo bộ lọc + escape NFR-10 + audit đủ filters/rowCount', async () => {
    // ô bắt đầu '=' phải được escape khi export (dữ liệu lưu raw — defer 2.9)
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({
        code: '=2+5',
        type: 'monitor',
        note: '=HYPERLINK("x")',
      })
      .expect(201);
    const res = await request(app.getHttpServer())
      .get('/api/admin/assets/export?type=monitor')
      .set(asAdmin())
      .expect(200)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('.xlsx');
    // parse lại buffer — nội dung là nguồn sự thật
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    // @types/node Buffer là generic (Buffer<ArrayBufferLike>) — exceljs khai Buffer non-generic
    await wb.xlsx.load(res.body as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const sheet = wb.worksheets[0];
    const codes: string[] = [];
    let evilRow: string[] | null = null;
    sheet.eachRow((row, n) => {
      if (n === 1) return; // header
      const values = (row.values as unknown[])
        .slice(1)
        .map((v) =>
          typeof v === 'string' || typeof v === 'number' ? String(v) : '',
        );
      codes.push(values[0]);
      if (values[0] === "'=2+5") evilRow = values;
    });
    // đúng các dòng theo bộ lọc type=monitor: PAGE-01..05 + máy mới
    expect(codes).toHaveLength(6);
    expect(codes).not.toContain('3-AA-CT-0042'); // laptop — ngoài bộ lọc
    // escape NFR-10: cả code lẫn note. 7.6 bỏ cột PLACE + MODEL → NOTE dời index 13→11
    expect(evilRow).not.toBeNull();
    expect(evilRow![11]).toBe(`'=HYPERLINK("x")`);
    // audit FR-43: ai, bộ lọc gì, bao nhiêu dòng
    const audit = await pool.query(
      "SELECT actor, detail FROM audit_log WHERE action = 'assets.export' ORDER BY created_at DESC LIMIT 1",
    );
    expect(audit.rows[0].actor).toBe('admin-t');
    expect(audit.rows[0].detail).toMatchObject({
      rowCount: 6,
      filters: { type: 'monitor', search: null, status: null },
    });
  });

  it('CHECK constraint status: giá trị lạ bị DB từ chối (nền 2.6)', async () => {
    await expect(
      pool.query(
        "INSERT INTO assets (code, type, status) VALUES ('BAD-ST', 'laptop', 'dang_bay')",
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('epic review F2: PUT trên tài sản đã thanh lý → 409 DISPOSED_TERMINAL, không sửa được gì', async () => {
    const m = (
      await pool.query(
        "SELECT id, version, assigned_user_sub FROM assets WHERE code = 'M-DISP'",
      )
    ).rows[0];
    const res = await request(app.getHttpServer())
      .put(`/api/admin/assets/${m.id}`)
      .set(asAdmin())
      .send({
        code: 'M-DISP',
        type: 'desktop',
        assignedUserSub: 'sub-u1', // cố viết lại "ai cầm lúc thanh lý"
        version: m.version,
      })
      .expect(409);
    expect(res.body.code).toBe('DISPOSED_TERMINAL');
    const after = await pool.query(
      'SELECT assigned_user_sub, version FROM assets WHERE id = $1',
      [m.id],
    );
    expect(after.rows[0]).toEqual({
      assigned_user_sub: m.assigned_user_sub,
      version: m.version,
    });
  });

  it('epic review: PUT software perpetual → term (đổi loại license hợp lệ) đi qua cả validate lẫn CHECK', async () => {
    const sw = (
      await pool.query("SELECT id, version FROM assets WHERE code = 'SW-02'")
    ).rows[0];
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${sw.id}`)
      .set(asAdmin())
      .send({
        code: 'SW-02',
        type: 'software',
        licenseName: 'Office LTSC',
        licenseType: 'term',
        endDate: '2028-01-31',
        version: sw.version,
      })
      .expect(200);
    const after = await pool.query(
      'SELECT license_type, license_name, end_date::text AS end_date FROM assets WHERE id = $1',
      [sw.id],
    );
    expect(after.rows[0]).toEqual({
      license_type: 'term',
      // sw-license-model-redesign: MỌI software bắt buộc license_name (định danh)
      license_name: 'Office LTSC',
      end_date: '2028-01-31',
    });
  });

  it('sw-model: phần mềm không mã, người đứng tên DERIVE theo máy, floating không holder, PUT không rò holder', async () => {
    const may = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({ code: 'SWM-MAY', type: 'desktop', assignedUserSub: 'sub-u1' })
      .expect(201);

    // tạo phần mềm KHÔNG mã, gắn máy → 201, code null
    const sw = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({
        type: 'software',
        licenseName: 'Autocad',
        licenseType: 'term',
        endDate: '2028-01-01',
        installedOnAssetId: may.body.id,
      })
      .expect(201);
    expect(sw.body.code).toBeNull();

    // chi tiết phần mềm → người đứng tên DERIVE = holder của máy (Trần Thị Bình)
    const detail = await request(app.getHttpServer())
      .get(`/api/admin/assets/${sw.body.id}`)
      .set(asAdmin())
      .expect(200);
    expect(detail.body.assignedUserName).toBe('Trần Thị Bình');

    // phần mềm floating (không gắn máy) → không người đứng tên
    const float = await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin())
      .send({
        type: 'software',
        licenseName: 'Office 365',
        licenseType: 'perpetual',
      })
      .expect(201);
    const floatDetail = await request(app.getHttpServer())
      .get(`/api/admin/assets/${float.body.id}`)
      .set(asAdmin())
      .expect(200);
    expect(floatDetail.body.assignedUserName).toBeNull();

    // PUT phần mềm CÓ gửi assignedUserSub → BE null-hóa (không rò holder), KHÔNG tạo allocation
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${sw.body.id}`)
      .set(asAdmin())
      .send({
        type: 'software',
        licenseName: 'Autocad',
        licenseType: 'term',
        endDate: '2028-01-01',
        assignedUserSub: 'sub-u1',
        version: sw.body.version,
      })
      .expect(200);
    const raw = await pool.query(
      'SELECT assigned_user_sub FROM assets WHERE id = $1',
      [sw.body.id],
    );
    expect(raw.rows[0]).toEqual({ assigned_user_sub: null });
    const alloc = await pool.query(
      'SELECT count(*)::int AS n FROM allocation_history WHERE asset_id = $1',
      [sw.body.id],
    );
    expect(alloc.rows[0].n).toBe(0);

    // AC5: list MÁY trả kèm tên license đang cài (cột "Phần mềm" ở /tai-san)
    const listMay = await request(app.getHttpServer())
      .get('/api/admin/assets?search=SWM-MAY')
      .set(asAdmin())
      .expect(200);
    const mayRow = listMay.body.items.find(
      (r: { id: string }) => r.id === may.body.id,
    );
    expect(mayRow.installedSoftware).toContain('Autocad');
  });

  it('export quá 10000 dòng → 400 EXPORT_TOO_LARGE (2.10)', async () => {
    await pool.query(`
      INSERT INTO assets (code, type)
      SELECT 'BULK-' || g, 'bulk' FROM generate_series(1, 10001) g
    `);
    const res = await request(app.getHttpServer())
      .get('/api/admin/assets/export?type=bulk')
      .set(asAdmin())
      .expect(400);
    expect(res.body.code).toBe('EXPORT_TOO_LARGE');
  });
});
