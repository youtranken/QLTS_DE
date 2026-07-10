import { describe, it, expect, vi } from 'vitest';
import { PoolPage } from './pool-page';
import type { Me } from './panels';
import {
  jsonResponse,
  renderWithI18n,
  screen,
} from './test/test-utils';

const ME = { sub: 'admin', role: 'admin', csrfToken: null } as unknown as Me;

// Pool là lưới thẻ máy (.mcatalog/.mcard) — không còn bảng sort/search.
const POOL = [
  { id: '1', code: 'PC-002', type: 'laptop', configuration: 'i5', brand: 'Dell', status: 'in_use', version: 1, assignedUserName: 'An' },
  { id: '2', code: 'PC-001', type: 'desktop', configuration: 'i7', brand: 'HP', status: 'in_use', version: 1, assignedUserName: null },
];

function stubPool() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      typeof url === 'string' && url.startsWith('/api/admin/pool')
        ? Promise.resolve(jsonResponse(200, POOL))
        : Promise.resolve(jsonResponse(200, { items: [] })),
    ),
  );
}

describe('PoolPage — lưới thẻ máy', () => {
  it('nạp và hiển thị các máy trong pool', async () => {
    stubPool();
    renderWithI18n(<PoolPage me={ME} />);
    expect(await screen.findByText('PC-002')).toBeInTheDocument();
    expect(await screen.findByText('PC-001')).toBeInTheDocument();
  });

  it('mỗi thẻ có nút Gỡ', async () => {
    stubPool();
    renderWithI18n(<PoolPage me={ME} />);
    await screen.findByText('PC-002');
    expect(screen.getAllByRole('button', { name: 'Gỡ' })).toHaveLength(2);
  });

  it('hiện chủ máy khi có người đứng tên', async () => {
    stubPool();
    renderWithI18n(<PoolPage me={ME} />);
    await screen.findByText('PC-002');
    expect(screen.getByText(/Chủ máy/)).toBeInTheDocument();
  });
});
