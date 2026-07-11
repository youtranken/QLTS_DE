import { InternalServerErrorException } from '@nestjs/common';
import { DirectorySyncService } from './directory-sync.service';
import type { DirectoryUser } from './directory.client';

interface ExistingRow {
  sub: string;
  email: string | null;
  employeeCode: string | null;
  fullName: string | null;
  groups: unknown;
  status: string;
}

function makeService(opts: {
  users?: DirectoryUser[];
  existingRows?: ExistingRow[];
  fetchError?: Error;
  txError?: Error;
}) {
  const inserted: unknown[] = [];
  const updatedSubs: string[] = [];
  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(opts.existingRows ?? []),
      }),
    }),
    insert: jest.fn().mockImplementation(() => ({
      values: jest.fn().mockImplementation((rows: unknown[]) => {
        inserted.push(...rows);
        return { onConflictDoUpdate: jest.fn().mockResolvedValue(undefined) };
      }),
    })),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((set: { email?: unknown }) => ({
        where: jest.fn().mockImplementation(() => {
          updatedSubs.push(JSON.stringify(set));
          return Promise.resolve(undefined);
        }),
      })),
    })),
  };
  const db = {
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (t: unknown) => Promise<void>) => {
        if (opts.txError) throw opts.txError;
        return fn(tx);
      }),
  };
  const directory = {
    fetchUsers: opts.fetchError
      ? jest.fn().mockRejectedValue(opts.fetchError)
      : jest.fn().mockResolvedValue(opts.users ?? []),
    fetchGroups: jest
      .fn()
      .mockResolvedValue([{ id: 'g1', name: 'Developers' }]),
  };
  const audit = { append: jest.fn().mockResolvedValue(undefined) };
  const systemConfig = {
    setAuthorizedGroups: jest.fn().mockResolvedValue(undefined),
  };
  const service = new DirectorySyncService(
    db as never,
    directory,
    audit as never,
    systemConfig as never,
  );
  return {
    service,
    db,
    directory,
    audit,
    systemConfig,
    inserted,
    updatedSubs,
  };
}

const user = (
  id: string,
  status: DirectoryUser['status'] = 'active',
  extra: Partial<DirectoryUser> = {},
): DirectoryUser => ({
  id,
  employee_code: `NV-${id}`,
  email: `${id}@pmh.com.vn`,
  full_name: `User ${id}`,
  status,
  groups: ['Developers'],
  ...extra,
});

const existingOf = (u: DirectoryUser): ExistingRow => ({
  sub: u.id,
  email: u.email ?? null,
  employeeCode: u.employee_code ?? null,
  fullName: u.full_name ?? null,
  groups: u.groups ?? [],
  status: u.status,
});

describe('DirectorySyncService (story 1.3 — sau review)', () => {
  it('user mới INSERT (batch), user đổi UPDATE, user y nguyên → unchanged (AC 2)', async () => {
    const a = user('a'); // đã có, không đổi
    const b = user('b'); // đã có, đổi tên
    const { service, inserted, updatedSubs, audit } = makeService({
      users: [a, { ...b, full_name: 'Tên mới' }, user('c')],
      existingRows: [existingOf(a), existingOf(b)],
    });
    const result = await service.sync('sa-1');
    expect(result).toMatchObject({
      total: 3,
      created: 1,
      updated: 1,
      unchanged: 1,
      skipped: 0,
    });
    expect(inserted).toHaveLength(1);
    expect(updatedSubs).toHaveLength(1);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'users.directory_sync' }),
    );
  });

  it('ghi authorized_groups từ fetchGroups (nguồn gate login 10.2)', async () => {
    const { service, systemConfig } = makeService({ users: [user('a')] });
    await service.sync('sa-1');
    expect(systemConfig.setAuthorizedGroups).toHaveBeenCalledWith([
      'Developers',
    ]);
  });

  it('sync THẤT BẠI (transaction rollback) → KHÔNG ghi authorized_groups', async () => {
    const { service, systemConfig } = makeService({
      users: [user('a')],
      txError: new Error('boom'),
    });
    await expect(service.sync('sa-1')).rejects.toThrow();
    expect(systemConfig.setAuthorizedGroups).not.toHaveBeenCalled();
  });

  it('record thiếu id → skipped, KHÔNG phá cả đợt; id trùng → khử trùng lặp', async () => {
    const { service, inserted } = makeService({
      users: [
        user('a'),
        { id: null as unknown as string, status: 'active', groups: [] },
        user('a', 'active', { full_name: 'Bản ghi sau thắng' }),
      ],
    });
    const result = await service.sync('sa-1');
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(1); // 'a' chỉ một lần
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { fullName: string }).fullName).toBe(
      'Bản ghi sau thắng',
    );
  });

  it('field undefined trong nguồn → GIỮ giá trị cũ (chống wipe dữ liệu)', async () => {
    const a = user('a');
    const { service, updatedSubs } = makeService({
      // email undefined (API bỏ sót field), status đổi → phải update nhưng giữ email
      users: [
        {
          id: 'a',
          status: 'locked',
          groups: ['Developers'],
          employee_code: 'NV-a',
          full_name: 'User a',
        },
      ],
      existingRows: [existingOf(a)],
    });
    const result = await service.sync('sa-1');
    expect(result.updated).toBe(1);
    const set = JSON.parse(updatedSubs[0]) as { email: string };
    expect(set.email).toBe('a@pmh.com.vn'); // giữ nguyên, không bị null
  });

  it('fetch lỗi → KHÔNG mở transaction, KHÔNG audit (AC 4)', async () => {
    const { service, db, audit } = makeService({
      fetchError: new Error('directory down'),
    });
    await expect(service.sync('sa-1')).rejects.toThrow('directory down');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('lỗi DB trong transaction → 500 DIRECTORY_SYNC_FAILED message tiếng Việt, không audit', async () => {
    const { service, audit } = makeService({
      users: [user('a')],
      txError: new Error('deadlock'),
    });
    await expect(service.sync('sa-1')).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('user chuyển deleted được phát hiện + ghi vào audit detail', async () => {
    const a = user('a');
    const { service, audit } = makeService({
      users: [{ ...a, status: 'deleted' }],
      existingRows: [existingOf(a)],
    });
    await service.sync('sa-1');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ deleted_detected: ['a'] }),
      }),
    );
  });

  it('danh bạ rỗng → 0/0/0, vẫn trả groups', async () => {
    const { service } = makeService({ users: [] });
    const result = await service.sync('sa-1');
    expect(result).toMatchObject({ total: 0, created: 0, updated: 0 });
    expect(result.groups).toHaveLength(1);
  });
});
