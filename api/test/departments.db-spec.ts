import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import { DepartmentsService } from '../src/modules/departments/departments.service';
import type { AuditEntry } from '../src/modules/audit/audit-writer.service';
import type { AuditWriterService } from '../src/modules/audit/audit-writer.service';

/** Story 7.1 — danh mục Phòng ban. Postgres thật (tên DB chứa "test"). */
if (!process.env.DATABASE_URL) {
  throw new Error('[departments.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[departments.db-spec] Từ chối chạy trên '${dbName}'.`);
}

describe('Departments (story 7.1)', () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle>;
  let service: DepartmentsService;
  let auditCalls: AuditEntry[];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    db = drizzle(pool);
    const auditStub = {
      append: (entry: AuditEntry) => {
        auditCalls.push(entry);
        return Promise.resolve();
      },
    } as unknown as AuditWriterService;
    service = new DepartmentsService(db, auditStub);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM department');
    auditCalls = [];
  });

  it('AC1 — tên trùng case-insensitive bị DB từ chối (unique lower(name))', async () => {
    await service.create('Kế toán', 'sa1');
    await expect(service.create('kế toán', 'sa1')).rejects.toMatchObject({
      response: { code: 'DEPARTMENT_NAME_TAKEN' },
    });
  });

  it('AC2 — create rồi listAll thấy; audit ghi action departments.create', async () => {
    const d = await service.create('Nhân sự', 'sa1');
    expect(d.name).toBe('Nhân sự');
    expect(d.active).toBe(true);
    const all = await service.listAll(1, 50);
    expect(all.items.map((x) => x.name)).toContain('Nhân sự');
    expect(auditCalls).toEqual([
      expect.objectContaining({
        action: 'departments.create',
        objectType: 'department',
        objectId: d.id,
      }),
    ]);
  });

  it('AC2 — đổi tên; đổi tên đụng tên khác → 409', async () => {
    const a = await service.create('Kỹ thuật', 'sa1');
    await service.create('Kinh doanh', 'sa1');
    const renamed = await service.update(a.id, { name: 'Kỹ thuật CN' }, 'sa1');
    expect(renamed.name).toBe('Kỹ thuật CN');
    await expect(
      service.update(a.id, { name: 'kinh doanh' }, 'sa1'),
    ).rejects.toMatchObject({ response: { code: 'DEPARTMENT_NAME_TAKEN' } });
  });

  it('AC3 — listActive chỉ trả active; listAll trả cả disabled', async () => {
    const a = await service.create('Phòng A', 'sa1');
    const b = await service.create('Phòng B', 'sa1');
    await service.update(b.id, { active: false }, 'sa1');
    const active = await service.listActive();
    expect(active.map((x) => x.name)).toEqual(['Phòng A']);
    expect(active.map((x) => x.id)).toContain(a.id);
    const all = await service.listAll(1, 50);
    expect(all.total).toBe(2);
  });

  it('AC4 — update id không tồn tại → NotFound', async () => {
    await expect(
      service.update(
        '00000000-0000-0000-0000-000000000000',
        { name: 'X' },
        'sa1',
      ),
    ).rejects.toMatchObject({ response: { code: 'DEPARTMENT_NOT_FOUND' } });
  });
});
