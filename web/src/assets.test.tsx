import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AssetsPage } from '@/assets';
import type { Me } from '@/me';
import {
  jsonResponse,
  renderWithI18n,
  screen,
  waitFor,
  userEvent,
} from '@/test/test-utils';

const ME = { sub: 'sa', role: 'sa', csrfToken: null } as unknown as Me;

const ROWS = [
  { id: '1', code: 'PC-01', type: 'laptop', status: 'in_use', isPool: false, assignedUserSub: null, assignedUserName: 'An', licenseWarning: false },
  { id: '2', code: 'PC-02', type: 'desktop', status: 'in_use', isPool: true, assignedUserSub: null, assignedUserName: null, licenseWarning: false },
];

function stub() {
  const fn = vi.fn((url: string) => {
    if (url.includes('/api/admin/assets/meta'))
      return Promise.resolve(jsonResponse(200, { types: ['laptop', 'desktop'] }));
    if (url.startsWith('/api/admin/assets?'))
      return Promise.resolve(jsonResponse(200, { items: ROWS, total: 2 }));
    return Promise.resolve(jsonResponse(200, {}));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function lastListUrl(fn: ReturnType<typeof stub>): string {
  const c = fn.mock.calls.filter((x) =>
    String(x[0]).startsWith('/api/admin/assets?'),
  );
  return String(c.at(-1)?.[0] ?? '');
}

describe('AssetsPage — sort server-side (manual)', () => {
  it('bấm header "Code" gửi ?sort=code&dir=asc lên server', async () => {
    const fn = stub();
    renderWithI18n(
      <MemoryRouter>
        <AssetsPage me={ME} />
      </MemoryRouter>,
    );
    await screen.findByText('PC-01');
    await userEvent.click(screen.getByRole('button', { name: /Code/ }));
    await waitFor(() => expect(lastListUrl(fn)).toContain('sort=code'));
    expect(lastListUrl(fn)).toContain('dir=asc');
  });
});
