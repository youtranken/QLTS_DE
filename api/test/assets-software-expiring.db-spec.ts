import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 7.7 — tìm theo software + badge/list "sắp hết hạn" (gộp thiết bị + license). */
if (!process.env.DATABASE_URL) {
  throw new Error('[assets-software-expiring.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(
    `[assets-software-expiring.db-spec] Từ chối chạy '${dbName}'.`,
  );
}

const asAdmin = { 'x-dev-user-sub': 'adm-se', 'x-dev-role': 'admin' };

describe('Assets — search software + expiring (story 7.7)', () => {
  let app: INestApplication;
  let pool: Pool;

  // end_date theo ngày VN + offset; null = không hạn
  const mkAsset = async (
    code: string,
    opts: {
      type?: string;
      endOffset?: number | null;
      status?: string;
      licenseType?: string | null;
      licenseName?: string | null;
      installedOn?: string | null;
    } = {},
  ) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, status, license_type, license_name, installed_on_asset_id, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,
         CASE WHEN $7::int IS NULL THEN NULL
              ELSE (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + $7::int END)
       RETURNING id`,
      [
        code,
        opts.type ?? 'laptop',
        opts.status ?? 'in_use',
        opts.licenseType ?? null,
        opts.licenseName ?? null,
        opts.installedOn ?? null,
        opts.endOffset ?? null,
      ],
    );
    return r.rows[0].id;
  };

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM assets');
  });

  const get = (qs: string) =>
    request(app.getHttpServer())
      .get(`/api/admin/assets?${qs}`)
      .set(asAdmin)
      .expect(200);

  it('AC1 — search theo mã software gắn máy → máy hiện', async () => {
    const m = await mkAsset('MACHINE-A', { type: 'laptop' });
    await mkAsset('OFFICE-2021', {
      type: 'software',
      licenseType: 'perpetual',
      licenseName: 'Office 2021 Pro',
      installedOn: m,
    });
    await mkAsset('MACHINE-B', { type: 'laptop' }); // không có software

    const res = await get('search=OFFICE');
    const codes = (res.body.items as { code: string }[]).map((a) => a.code);
    expect(codes).toContain('MACHINE-A'); // máy có software khớp
    expect(codes).toContain('OFFICE-2021'); // software row khớp mã
    expect(codes).not.toContain('MACHINE-B');
  });

  it('AC1 — search theo license_name của software gắn máy → máy hiện', async () => {
    const m = await mkAsset('MACHINE-C');
    await mkAsset('SW-1', {
      type: 'software',
      licenseType: 'term',
      licenseName: 'Adobe Photoshop',
      endOffset: 100,
      installedOn: m,
    });
    const res = await get('search=Photoshop');
    const codes = (res.body.items as { code: string }[]).map((a) => a.code);
    expect(codes).toContain('MACHINE-C');
    expect(codes).toContain('SW-1');
  });

  it('AC2 — countExpiring gộp thiết bị + license term đang gắn; loại disposed/perpetual/chưa-gắn/far', async () => {
    await mkAsset('DEV-SOON', { type: 'laptop', endOffset: 10 }); // ĐẾM
    await mkAsset('DEV-PAST', { type: 'laptop', endOffset: -5 }); // ĐẾM (đã quá hạn)
    await mkAsset('DEV-FAR', { type: 'laptop', endOffset: 60 }); // không
    await mkAsset('DEV-DISPOSED', {
      type: 'laptop',
      endOffset: 5,
      status: 'disposed',
    }); // không (disposed)
    const host = await mkAsset('HOST-1');
    await mkAsset('SW-TERM-INSTALLED', {
      type: 'software',
      licenseType: 'term',
      endOffset: 7,
      installedOn: host,
    }); // ĐẾM
    await mkAsset('SW-PERP', {
      type: 'software',
      licenseType: 'perpetual',
      licenseName: 'Perpetual X',
      endOffset: null,
      installedOn: host,
    }); // không (không hạn)
    await mkAsset('SW-TERM-UNLINKED', {
      type: 'software',
      licenseType: 'term',
      endOffset: 7,
      installedOn: null,
    }); // không (chưa gắn máy)

    const res = await request(app.getHttpServer())
      .get('/api/admin/assets/expiring-count')
      .set(asAdmin)
      .expect(200);
    expect(res.body.count).toBe(3); // DEV-SOON, DEV-PAST, SW-TERM-INSTALLED
  });

  it('AC3 — list ?expiring=true trả đúng tập "sắp hết hạn"', async () => {
    await mkAsset('E-SOON', { endOffset: 10 });
    await mkAsset('E-FAR', { endOffset: 60 });
    const res = await get('expiring=true');
    const codes = (res.body.items as { code: string }[]).map((a) => a.code);
    expect(codes).toContain('E-SOON');
    expect(codes).not.toContain('E-FAR');
  });
});
