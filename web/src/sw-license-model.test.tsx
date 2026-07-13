import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AssetsPage } from './assets';
import { AssetForm } from './asset-form';
import { EMPTY_FORM } from './asset-types';
import type { Me } from './panels';
import {
  jsonResponse,
  renderWithI18n,
  screen,
  waitFor,
} from './test/test-utils';

const ME = { sub: 'sa', role: 'sa', csrfToken: null } as unknown as Me;

// Phần mềm (sw-license-model-redesign): định danh bằng licenseName, không mã; holder derive từ máy.
const SW_ROWS = [
  {
    id: 's1',
    code: null,
    type: 'software',
    status: 'in_use',
    isPool: false,
    assignedUserSub: 'u1',
    assignedUserName: 'Trần Thị Bình',
    licenseName: 'Autocad 2025',
    licenseType: 'term',
    installedOnCode: 'PC-01',
    endDate: '2028-07-01',
    licenseWarning: false,
  },
  {
    id: 's2',
    code: null,
    type: 'software',
    status: 'in_use',
    isPool: false,
    assignedUserSub: null,
    assignedUserName: null,
    licenseName: 'Office 365',
    licenseType: 'perpetual',
    installedOnCode: null, // floating — chưa gắn máy
    endDate: null,
    licenseWarning: false,
  },
];

function stubList(rows: unknown[]) {
  const fn = vi.fn((url: string) => {
    if (url.includes('/api/admin/assets/meta'))
      return Promise.resolve(jsonResponse(200, { types: ['software'] }));
    if (url.startsWith('/api/admin/assets?'))
      return Promise.resolve(jsonResponse(200, { items: rows, total: rows.length }));
    return Promise.resolve(jsonResponse(200, []));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('Tab Phần mềm — cột định danh bằng Tên license (AC6)', () => {
  it('hiện Tên license + Máy + người derive + kỳ hạn; không có cột Mã tài sản', async () => {
    stubList(SW_ROWS);
    renderWithI18n(
      <MemoryRouter>
        <AssetsPage me={ME} softwareOnly />
      </MemoryRouter>,
    );
    // Định danh = licenseName, không phải mã
    await screen.findByText('Autocad 2025');
    expect(screen.getByText('Office 365')).toBeInTheDocument();
    // Header cột: Tên license, Máy, Kỳ hạn — KHÔNG có header "Mã tài sản"
    expect(
      screen.getByRole('columnheader', { name: /License Name/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Máy/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: /^Code$/ }),
    ).not.toBeInTheDocument();
    // Máy gắn + người đứng tên derive từ máy
    expect(screen.getByText('PC-01')).toBeInTheDocument();
    expect(screen.getByText('Trần Thị Bình')).toBeInTheDocument();
    // Kỳ hạn: term → ngày hết hạn; perpetual → "Vĩnh viễn"
    expect(screen.getByText('2028-07-01')).toBeInTheDocument();
    expect(screen.getByText('Vĩnh viễn')).toBeInTheDocument();
  });
});

describe('Form phần mềm — bỏ Mã/Người đứng tên (AC2)', () => {
  it('form tạo phần mềm không có ô Mã tài sản, không có khối Người đứng tên, có Tên license', async () => {
    // catalog + các fetch phụ trả rỗng
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(200, []))),
    );
    renderWithI18n(
      <AssetForm
        me={ME}
        initial={{ ...EMPTY_FORM, isSoftware: true }}
        onDone={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText('License Name')).toBeInTheDocument(),
    );
    // Phần mềm: KHÔNG có ô "Code", KHÔNG có khối "User" (người đứng tên), KHÔNG có Configuration
    expect(screen.queryByText('Code')).not.toBeInTheDocument();
    expect(screen.queryByText('User')).not.toBeInTheDocument();
    expect(screen.queryByText('Configuration')).not.toBeInTheDocument();
  });
});
