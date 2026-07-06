import { DirectorySyncService } from './directory-sync.service';
import type { DirectoryUser } from './directory.client';

function makeService(opts: {
  users?: DirectoryUser[];
  existingSubs?: string[];
  fetchError?: Error;
}) {
  const txOps: string[] = [];
  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest
          .fn()
          .mockResolvedValue((opts.existingSubs ?? []).map((sub) => ({ sub }))),
      }),
    }),
    update: jest.fn().mockImplementation(() => {
      txOps.push('update');
      return {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      };
    }),
    insert: jest.fn().mockImplementation(() => {
      txOps.push('insert');
      return { values: jest.fn().mockResolvedValue(undefined) };
    }),
  };
  const db = {
    transaction: jest
      .fn()
      .mockImplementation(async (fn: (t: unknown) => Promise<void>) => fn(tx)),
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
  const service = new DirectorySyncService(
    db as never,
    directory,
    audit as never,
  );
  return { service, db, directory, audit, txOps };
}

const user = (
  id: string,
  status: DirectoryUser['status'] = 'active',
): DirectoryUser => ({
  id,
  employee_code: `NV-${id}`,
  email: `${id}@pmh.com.vn`,
  full_name: `User ${id}`,
  status,
  groups: ['Developers'],
});

describe('DirectorySyncService (story 1.3)', () => {
  it('đếm đúng created/updated: user mới INSERT, user cũ UPDATE (AC 2)', async () => {
    const { service, txOps, audit } = makeService({
      users: [user('a'), user('b'), user('c')],
      existingSubs: ['a'],
    });
    const result = await service.sync('sa-1');
    expect(result).toMatchObject({ total: 3, created: 2, updated: 1 });
    expect(txOps.filter((o) => o === 'insert')).toHaveLength(2);
    expect(txOps.filter((o) => o === 'update')).toHaveLength(1);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'sa-1',
        action: 'users.directory_sync',
        detail: expect.objectContaining({ total: 3, created: 2, updated: 1 }),
      }),
    );
  });

  it('status deleted/locked được ghi nhận (đối soát offboarding)', async () => {
    const { service } = makeService({
      users: [user('a', 'deleted'), user('b', 'locked')],
    });
    const result = await service.sync('sa-1');
    expect(result.total).toBe(2);
  });

  it('fetch lỗi → KHÔNG mở transaction, KHÔNG audit (AC 4)', async () => {
    const { service, db, audit } = makeService({
      fetchError: new Error('directory down'),
    });
    await expect(service.sync('sa-1')).rejects.toThrow('directory down');
    expect(db.transaction).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('danh bạ rỗng → 0/0/0, vẫn trả groups', async () => {
    const { service } = makeService({ users: [] });
    const result = await service.sync('sa-1');
    expect(result).toMatchObject({ total: 0, created: 0, updated: 0 });
    expect(result.groups).toHaveLength(1);
  });
});
