import { describe, it, expect, vi } from 'vitest';
import { PoolPage } from './pool-page';
import type { Me } from './panels';
import {
  jsonResponse,
  renderWithI18n,
  screen,
  within,
  waitFor,
  userEvent,
} from './test/test-utils';

const ME = { sub: 'admin', role: 'admin', csrfToken: null } as unknown as Me;

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

function codeColumn(): (string | null)[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0].textContent);
}

describe('PoolPage — dùng DataTable (sort + search)', () => {
  it('nạp danh sách pool và hiển thị', async () => {
    stubPool();
    renderWithI18n(<PoolPage me={ME} />);
    expect(await screen.findByText('PC-002')).toBeInTheDocument();
    expect(await screen.findByText('PC-001')).toBeInTheDocument();
  });

  it('bấm header "Mã tài sản" sắp xếp tăng dần', async () => {
    stubPool();
    renderWithI18n(<PoolPage me={ME} />);
    await screen.findByText('PC-002');
    await userEvent.click(screen.getByRole('button', { name: /Mã tài sản/ }));
    expect(codeColumn()).toEqual(['PC-001', 'PC-002']);
  });

  it('gõ ô lọc thu hẹp theo hãng', async () => {
    stubPool();
    renderWithI18n(<PoolPage me={ME} />);
    await screen.findByText('PC-002');
    await userEvent.type(
      screen.getByLabelText('Lọc theo mã / loại / hãng…'),
      'HP',
    );
    await waitFor(() =>
      expect(screen.queryByText('PC-002')).not.toBeInTheDocument(),
    );
    expect(codeColumn()).toEqual(['PC-001']); // chỉ máy hãng HP
  });
});
