import { describe, it, expect, vi } from 'vitest';
import { CatalogPage } from './catalog-page';
import type { Me } from './panels';
import {
  jsonResponse,
  renderWithI18n,
  screen,
  within,
  waitFor,
  userEvent,
} from './test/test-utils';

const ME = { sub: 'sa', role: 'sa', csrfToken: null } as unknown as Me;

const ITEMS = [
  { id: '1', value: 'Laptop', active: true, usage: 5 },
  { id: '2', value: 'Desktop', active: true, usage: 12 },
  { id: '3', value: 'Monitor', active: false, usage: 0 },
];

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      typeof url === 'string' && url.includes('/api/admin/catalog')
        ? Promise.resolve(jsonResponse(200, ITEMS))
        : Promise.resolve(jsonResponse(200, [])),
    ),
  );
}

function valueColumn(): (string | null)[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0].textContent);
}

describe('CatalogPage — dùng DataTable', () => {
  it('sắp xếp theo "Số tài sản" tăng dần', async () => {
    stub();
    renderWithI18n(<CatalogPage me={ME} />);
    await screen.findByText('Laptop');
    await userEvent.click(screen.getByRole('button', { name: /Số tài sản/ }));
    expect(valueColumn()).toEqual(['Monitor', 'Laptop', 'Desktop']); // 0,5,12
  });

  it('lọc thu hẹp danh sách', async () => {
    stub();
    renderWithI18n(<CatalogPage me={ME} />);
    await screen.findByText('Laptop');
    await userEvent.type(screen.getByLabelText('Lọc giá trị…'), 'Desk');
    await waitFor(() =>
      expect(screen.queryByText('Laptop')).not.toBeInTheDocument(),
    );
    expect(valueColumn()).toEqual(['Desktop']);
  });

  it('inline-edit vẫn hoạt động qua DataTable (bấm Sửa → ô nhập)', async () => {
    stub();
    renderWithI18n(<CatalogPage me={ME} />);
    await screen.findByText('Laptop');
    // Sửa dòng đầu (Laptop) → ô value thành input
    await userEvent.click(screen.getAllByRole('button', { name: 'Sửa' })[0]);
    expect(screen.getByDisplayValue('Laptop')).toBeInTheDocument();
  });
});
