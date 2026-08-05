import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './test-app.helper';

/**
 * E2E phân quyền + validate sổ tài sản (story 2.1, NFR-7) — seam AUTH_DEV_MODE.
 * Nghiệp vụ ghi DB thật ở assets.db-spec; ở đây chỉ request bị chặn TRƯỚC service.
 */
describe('Sổ tài sản — phân quyền & validate (story 2.1)', () => {
  let app: INestApplication;
  const UUID = '2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f';

  const asMember = { 'x-dev-user-sub': 'member-1', 'x-dev-role': 'member' };
  const asAdmin = { 'x-dev-user-sub': 'admin-1', 'x-dev-role': 'admin' };

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.AUTH_DEV_MODE;
  });

  it('member gọi list/chi tiết/tạo/sửa → 403 (AC 1, NFR-7)', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/assets')
      .set(asMember)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/admin/assets/${UUID}`)
      .set(asMember)
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asMember)
      .send({ code: 'A-1', type: 'laptop' })
      .expect(403);
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}`)
      .set(asMember)
      .send({ code: 'A-1', type: 'laptop', version: 1 })
      .expect(403);
  });

  it('không đăng nhập → 401', async () => {
    await request(app.getHttpServer()).get('/api/admin/assets').expect(401);
  });

  it('thiếu code/type → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ type: 'laptop' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: 'A-1' })
      .expect(400);
  });

  it('code/type toàn khoảng trắng → 400 (trim trước validate, review 2.1)', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: '   ', type: 'laptop' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: 'A-1', type: '  ' })
      .expect(400);
  });

  it('cost vượt Number.MAX_SAFE_INTEGER → 400 (không lọt 500 bigint, review 2.1)', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: 'A-1', type: 'laptop', cost: 10000000000000000000 })
      .expect(400);
  });

  it('giá âm / ngày sai định dạng / ngày không tồn tại → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: 'A-1', type: 'laptop', cost: -5 })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: 'A-1', type: 'laptop', startDate: '15/01/2026' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: 'A-1', type: 'laptop', endDate: '2026-13-40' })
      .expect(400);
  });

  it('PUT thiếu version (optimistic lock bắt buộc) → 400 (AC 3)', async () => {
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}`)
      .set(asAdmin)
      .send({ code: 'A-1', type: 'laptop' })
      .expect(400);
  });

  it('id không phải uuid → 400 (không lộ 500)', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/assets/khong-phai-uuid')
      .set(asAdmin)
      .expect(400);
  });

  it('lịch sử cấp phát (2.3): member → 403; allocationNote quá 500 ký tự → 400', async () => {
    await request(app.getHttpServer())
      .get(`/api/admin/assets/${UUID}/allocations`)
      .set(asMember)
      .expect(403);
    // 2.7: tab note tình trạng cũng là API quản trị — member 403
    await request(app.getHttpServer())
      .get(`/api/admin/assets/${UUID}/notes`)
      .set(asMember)
      .expect(403);
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}`)
      .set(asAdmin)
      .send({
        code: 'A-1',
        type: 'laptop',
        version: 1,
        allocationNote: 'x'.repeat(501),
      })
      .expect(400);
  });

  it('software (2.4): licenseType ngoài enum / installedOnAssetId không uuid → 400; member 403 GET :id/software', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({ code: 'SW-1', type: 'software', licenseType: 'mua-dut' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/admin/assets')
      .set(asAdmin)
      .send({
        code: 'SW-1',
        type: 'software',
        licenseType: 'term',
        endDate: '2027-01-01',
        installedOnAssetId: 'khong-uuid',
      })
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/admin/assets/${UUID}/software`)
      .set(asMember)
      .expect(403);
  });

  it('chuyển license (2.5): member 403; targetAssetId không uuid / thiếu version → 400', async () => {
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}/transfer`)
      .set(asMember)
      .send({ version: 1 })
      .expect(403);
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}/transfer`)
      .set(asAdmin)
      .send({ targetAssetId: 'khong-uuid', version: 1 })
      .expect(400);
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}/transfer`)
      .set(asAdmin)
      .send({})
      .expect(400);
  });

  it('vòng đời (2.6): member 403 cả 4 endpoint; thiếu lý do / eta sai / isPool sai → 400', async () => {
    for (const [method, path, body] of [
      ['post', 'lock', { reason: 'x', version: 1 }],
      ['post', 'unlock', { version: 1 }],
      ['post', 'dispose', { version: 1 }],
      ['put', 'pool', { isPool: true, version: 1 }],
    ] as const) {
      await request(app.getHttpServer())
        [method](`/api/admin/assets/${UUID}/${path}`)
        .set(asMember)
        .send(body)
        .expect(403);
    }
    // thiếu lý do khóa (bắt buộc FR-33) / lý do toàn khoảng trắng
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${UUID}/lock`)
      .set(asAdmin)
      .send({ version: 1 })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${UUID}/lock`)
      .set(asAdmin)
      .send({ reason: '   ', version: 1 })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/admin/assets/${UUID}/lock`)
      .set(asAdmin)
      .send({ reason: 'x', eta: '01/08/2026', version: 1 })
      .expect(400);
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}/pool`)
      .set(asAdmin)
      .send({ isPool: 'yes', version: 1 })
      .expect(400);
  });

  it('import (2.9): member 403 cả 3 endpoint; file không phải xlsx → 400', async () => {
    for (const path of ['preview', 'commit', 'rematch']) {
      await request(app.getHttpServer())
        .post(`/api/admin/assets-import/${path}`)
        .set(asMember)
        .expect(403);
    }
    const res = await request(app.getHttpServer())
      .post('/api/admin/assets-import/preview')
      .set(asAdmin)
      .attach('file', Buffer.from('%PDF-1.7 gia xlsx'), 'gia.xlsx')
      .expect(400);
    expect(res.body.code).toBe('UNSUPPORTED_FILE');
  });

  it('export (2.10): member → 403; anonymous → 401 (FR-43 kênh exfil có quyền)', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/assets/export')
      .set(asMember)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/admin/assets/export')
      .expect(401);
  });

  it('lọc status ngoài enum → 400; member gọi meta → 403 (story 2.2)', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/assets?status=dang_bay')
      .set(asAdmin)
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/admin/assets/meta')
      .set(asMember)
      .expect(403);
  });

  it('đổi người đứng tên (11.2): member 403; anonymous 401; thiếu version → 400', async () => {
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}/assignee`)
      .set(asMember)
      .send({ assignedUserSub: 'sub-x', version: 1 })
      .expect(403);
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}/assignee`)
      .send({ version: 1 })
      .expect(401);
    await request(app.getHttpServer())
      .put(`/api/admin/assets/${UUID}/assignee`)
      .set(asAdmin)
      .send({})
      .expect(400);
  });

  it('xóa (11.1): member 403; anonymous 401; id non-uuid / thiếu version → 400', async () => {
    await request(app.getHttpServer())
      .delete(`/api/admin/assets/${UUID}`)
      .set(asMember)
      .send({ version: 1 })
      .expect(403);
    await request(app.getHttpServer())
      .delete(`/api/admin/assets/${UUID}`)
      .send({ version: 1 })
      .expect(401);
    await request(app.getHttpServer())
      .delete('/api/admin/assets/khong-uuid')
      .set(asAdmin)
      .send({ version: 1 })
      .expect(400);
    await request(app.getHttpServer())
      .delete(`/api/admin/assets/${UUID}`)
      .set(asAdmin)
      .send({})
      .expect(400);
  });
});
