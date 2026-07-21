import { describe, it, expect, vi } from 'vitest';
import { PoolPage } from './pool-page';
import type { Me } from './me';
import {
  jsonResponse,
  renderWithI18n,
  screen,
} from './test/test-utils';

const ME = { sub: 'admin', role: 'admin', csrfToken: null } as unknown as Me;

// Pool (đại tu pool.html): bảng No/Code/User/Asset Type/Software + 3 thẻ Tổng/Sẵn sàng/Đang mượn.
// Cột User = người ĐANG mượn (currentBorrowerName), "—" khi máy sẵn sàng.
const POOL = [
  { id: '1', code: 'PC-002', type: 'laptop', configuration: 'i5', brand: 'Dell', status: 'in_use', version: 1, assignedUserName: 'An', installedSoftware: 'Office, AutoCAD', currentBorrowerName: 'Trần Văn Hùng' },
  { id: '2', code: 'PC-001', type: 'desktop', configuration: 'i7', brand: 'HP', status: 'in_use', version: 1, assignedUserName: null, installedSoftware: null, currentBorrowerName: null },
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

describe('PoolPage — bảng pool (No/Code/User/Asset Type/Software)', () => {
  it('nạp và hiển thị các máy trong pool', async () => {
    stubPool();
    renderWithI18n(<PoolPage me={ME} />);
    expect(await screen.findByText('PC-002')).toBeInTheDocument();
    expect(await screen.findByText('PC-001')).toBeInTheDocument();
  });

  it('mỗi hàng có nút Gỡ', async () => {
    stubPool();
    renderWithI18n(<PoolPage me={ME} />);
    await screen.findByText('PC-002');
    expect(screen.getAllByRole('button', { name: 'Gỡ' })).toHaveLength(2);
  });

  it('cột User hiện người đang mượn', async () => {
    stubPool();
    renderWithI18n(<PoolPage me={ME} />);
    await screen.findByText('PC-002');
    expect(screen.getByText('Trần Văn Hùng')).toBeInTheDocument();
  });
});
