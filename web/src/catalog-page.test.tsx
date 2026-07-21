import { describe, it, expect, vi } from 'vitest';
import { CatalogPage } from './catalog-page';
import type { Me } from './me';
import {
  jsonResponse,
  renderWithI18n,
  screen,
  userEvent,
} from './test/test-utils';

const ME = { sub: 'sa', role: 'sa', csrfToken: null } as unknown as Me;

// Danh mục là bảng 3 cột (Loại/Hãng/Cấu hình). Chỉ nạp cột "type" để giá trị
// không lặp giữa các cột (tránh nhập nhằng khi query theo text).
const ITEMS = [
  { id: '1', value: 'Laptop', active: true, deviceCount: 5, softwareCount: 0 },
  { id: '2', value: 'Desktop', active: true, deviceCount: 12, softwareCount: 0 },
  { id: '3', value: 'Monitor', active: false, deviceCount: 0, softwareCount: 0 },
];

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      typeof url === 'string' && url.includes('kind=type')
        ? Promise.resolve(jsonResponse(200, ITEMS))
        : Promise.resolve(jsonResponse(200, [])),
    ),
  );
}

describe('CatalogPage — bảng 3 cột', () => {
  it('hiển thị các giá trị trong cột Loại', async () => {
    stub();
    renderWithI18n(<CatalogPage me={ME} />);
    expect(await screen.findByText('Laptop')).toBeInTheDocument();
    expect(screen.getByText('Desktop')).toBeInTheDocument();
    expect(screen.getByText('Monitor')).toBeInTheDocument();
  });

  it('giá trị đang disable: hàng gạch ngang + mờ (class is-disabled), không chữ "disable"', async () => {
    stub();
    renderWithI18n(<CatalogPage me={ME} />);
    const monitor = await screen.findByText('Monitor'); // active:false
    expect(monitor.closest('.dmrow')).toHaveClass('is-disabled');
    // Không còn badge chữ trên hàng (chỉ gạch ngang + mờ)
    expect(monitor.closest('.dmrow')).not.toHaveTextContent(/đã disable/i);
  });

  it('menu ⋯ → Sửa mở ô nhập inline', async () => {
    stub();
    renderWithI18n(<CatalogPage me={ME} />);
    await screen.findByText('Laptop');
    // ⋯ của hàng đầu (Laptop) → Sửa → input hiện giá trị hiện tại
    await userEvent.click(screen.getAllByLabelText('Thao tác')[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Sửa' }));
    expect(screen.getByDisplayValue('Laptop')).toBeInTheDocument();
  });
});
