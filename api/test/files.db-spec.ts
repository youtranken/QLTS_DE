import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

if (!process.env.DATABASE_URL) {
  throw new Error('[files.db-spec] DATABASE_URL chưa đặt — cần Postgres thật.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[files.db-spec] Từ chối chạy trên DB '${dbName}'.`);
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('noi dung anh gia lap cho test'),
]);
const PDF = Buffer.from('%PDF-1.7\ntest bien ban kiem ke');

describe('Module file + kiểm kê trên DB thật (story 2.8)', () => {
  let app: INestApplication;
  let pool: Pool;
  let storageDir: string;

  const asAdmin = () => ({
    'x-dev-user-sub': 'admin-t',
    'x-dev-role': 'admin',
  });

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    storageDir = mkdtempSync(join(tmpdir(), 'qlts-files-'));
    process.env.FILE_STORAGE_DIR = storageDir;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    rmSync(storageDir, { recursive: true, force: true });
    delete process.env.AUTH_DEV_MODE;
    delete process.env.FILE_STORAGE_DIR;
  });

  let fileId: string;

  it('upload png thật → row + file trên đĩa tên uuid + audit files.upload (AC 1)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/admin/files')
      .set(asAdmin())
      .field('kind', 'image')
      .attach('file', PNG, 'bien-ban chụp.png')
      .expect(201);
    expect(res.body).toMatchObject({
      originalName: 'bien-ban chụp.png',
      mime: 'image/png',
      kind: 'image',
      sizeBytes: PNG.length,
      uploadedBy: 'admin-t',
    });
    fileId = res.body.id as string;
    // file trên đĩa đúng tên uuid (AD-6)
    expect(readdirSync(storageDir)).toContain(fileId);
    const audit = await pool.query(
      "SELECT actor FROM audit_log WHERE action = 'files.upload'",
    );
    expect(audit.rowCount).toBe(1);
  });

  it('đuôi .png nhưng bytes exe → 400 UNSUPPORTED_FILE; kind lệch → 400 WRONG_FILE_KIND', async () => {
    const fake = await request(app.getHttpServer())
      .post('/api/admin/files')
      .set(asAdmin())
      .field('kind', 'image')
      .attach('file', Buffer.from([0x4d, 0x5a, 0x90, 0x00]), 'virus.png')
      .expect(400);
    expect(fake.body.code).toBe('UNSUPPORTED_FILE');
    const wrongKind = await request(app.getHttpServer())
      .post('/api/admin/files')
      .set(asAdmin())
      .field('kind', 'document')
      .attach('file', PNG, 'anh.png')
      .expect(400);
    expect(wrongKind.body.code).toBe('WRONG_FILE_KIND');
  });

  it('ảnh vượt 5MB → 400 FILE_TOO_LARGE (NFR-4)', async () => {
    const big = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(5 * 1024 * 1024),
    ]);
    const res = await request(app.getHttpServer())
      .post('/api/admin/files')
      .set(asAdmin())
      .field('kind', 'image')
      .attach('file', big, 'to.png')
      .expect(400);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
    // không để lại file mồ côi... file đã ghi rồi mới validate? KHÔNG — validate trước khi ghi
    expect(readdirSync(storageDir)).toHaveLength(1);
  });

  it('biên bản vượt trần multer 20MB → 413 (không lọt 500)', async () => {
    const huge = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(20 * 1024 * 1024),
    ]);
    await request(app.getHttpServer())
      .post('/api/admin/files')
      .set(asAdmin())
      .field('kind', 'document')
      .attach('file', huge, 'qua-to.pdf')
      .expect(413);
    // không để lại file mồ côi
    expect(readdirSync(storageDir)).toHaveLength(1);
  });

  it('download: đúng bytes + attachment + octet-stream + nosniff + audit files.download (AC 2, FR-43)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/admin/files/${fileId}/download`)
      .set(asAdmin())
      .expect(200)
      .buffer()
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(
      encodeURIComponent('bien-ban chụp.png'),
    );
    expect(Buffer.compare(res.body as Buffer, PNG)).toBe(0);
    const audit = await pool.query(
      "SELECT actor, object_id FROM audit_log WHERE action = 'files.download'",
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].object_id).toBe(fileId);
  });

  it('kiểm kê: tạo đợt + upload nhiều biên bản + list theo năm giảm dần (AC 3, FR-39)', async () => {
    const r2025 = await request(app.getHttpServer())
      .post('/api/admin/inventory-rounds')
      .set(asAdmin())
      .send({ year: 2025, note: 'Kiểm kê cuối năm 2025' })
      .expect(201);
    const r2026 = await request(app.getHttpServer())
      .post('/api/admin/inventory-rounds')
      .set(asAdmin())
      .send({ year: 2026 })
      .expect(201);
    // 2 biên bản vào đợt 2026 (pdf + ảnh chụp biên bản giấy)
    await request(app.getHttpServer())
      .post(`/api/admin/inventory-rounds/${r2026.body.id}/files`)
      .set(asAdmin())
      .attach('file', PDF, 'bien-ban-2026.pdf')
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/admin/inventory-rounds/${r2026.body.id}/files`)
      .set(asAdmin())
      .attach('file', PNG, 'chup-bien-ban.png')
      .expect(201);
    const list = await request(app.getHttpServer())
      .get('/api/admin/inventory-rounds')
      .set(asAdmin())
      .expect(200);
    const rounds = list.body as Array<{
      id: string;
      year: number;
      files: Array<{ originalName: string }>;
    }>;
    expect(rounds.map((r) => r.year)).toEqual([2026, 2025]);
    expect(rounds[0].files.map((f) => f.originalName).sort()).toEqual([
      'bien-ban-2026.pdf',
      'chup-bien-ban.png',
    ]);
    expect(rounds[1].files).toEqual([]);
    // đợt với uuid lạ → 404
    await request(app.getHttpServer())
      .post(
        '/api/admin/inventory-rounds/2f6b2a1e-9d3c-4a7b-8e5f-1a2b3c4d5e6f/files',
      )
      .set(asAdmin())
      .attach('file', PDF, 'x.pdf')
      .expect(404);
    void r2025;
  });

  it('KHÔNG có chức năng xóa: DELETE đợt/file → 404 (AC 3)', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/admin/inventory-rounds')
      .set(asAdmin())
      .expect(200);
    const roundId = (list.body as Array<{ id: string }>)[0].id;
    await request(app.getHttpServer())
      .delete(`/api/admin/inventory-rounds/${roundId}`)
      .set(asAdmin())
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/admin/files/${fileId}`)
      .set(asAdmin())
      .expect(404);
  });
});
