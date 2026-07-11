import { AuthorizedGroupsService } from './authorized-groups.service';

function make(opts: { stored?: string[]; fetch?: string[] } = {}) {
  const stored = { value: opts.stored ?? ([] as string[]) };
  const fetchGroups = jest
    .fn()
    .mockResolvedValue(
      (opts.fetch ?? ['Developers']).map((name, i) => ({ id: String(i), name })),
    );
  const directory = { fetchUsers: jest.fn(), fetchGroups };
  const config = {
    getAuthorizedGroups: jest.fn(() => Promise.resolve(stored.value)),
    setAuthorizedGroups: jest.fn((n: string[]) => {
      stored.value = n;
      return Promise.resolve();
    }),
  };
  const svc = new AuthorizedGroupsService(directory as never, config as never);
  return { svc, directory, config, stored, fetchGroups };
}

describe('AuthorizedGroupsService (self-heal, story 10.3)', () => {
  it('current() đọc từ config', async () => {
    const { svc } = make({ stored: ['Developers'] });
    expect(await svc.current()).toEqual(['Developers']);
  });

  it('refreshForLogin: fetch tươi + persist vào config', async () => {
    const { svc, config, stored } = make({ fetch: ['Developers', 'Kế toán'] });
    const r = await svc.refreshForLogin();
    expect(r).toEqual(['Developers', 'Kế toán']);
    expect(config.setAuthorizedGroups).toHaveBeenCalledWith([
      'Developers',
      'Kế toán',
    ]);
    expect(stored.value).toEqual(['Developers', 'Kế toán']);
  });

  it('cache TTL: 2 lần liên tiếp chỉ fetch 1 lần (chống lạm dụng)', async () => {
    const { svc, fetchGroups } = make({});
    await svc.refreshForLogin();
    await svc.refreshForLogin();
    expect(fetchGroups).toHaveBeenCalledTimes(1);
  });

  it('clearCache → fetch lại', async () => {
    const { svc, fetchGroups } = make({});
    await svc.refreshForLogin();
    svc.clearCache();
    await svc.refreshForLogin();
    expect(fetchGroups).toHaveBeenCalledTimes(2);
  });

  it('fetch lỗi → trả bản đã lưu (fallback), KHÔNG ném, KHÔNG ghi đè config', async () => {
    const { svc, directory, config } = make({ stored: ['Developers'] });
    directory.fetchGroups.mockRejectedValue(new Error('PMH down'));
    const r = await svc.refreshForLogin();
    expect(r).toEqual(['Developers']);
    expect(config.setAuthorizedGroups).not.toHaveBeenCalled();
  });
});
