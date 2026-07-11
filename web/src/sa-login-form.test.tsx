import { describe, it, expect, vi, afterEach } from 'vitest';
import { SaLoginForm } from './sa-login-form';
import {
  jsonResponse,
  renderWithI18n,
  screen,
  userEvent,
} from './test/test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openForm() {
  renderWithI18n(<SaLoginForm />);
  await userEvent.click(screen.getByRole('button', { name: /SA nội bộ/i }));
  await userEvent.type(screen.getByPlaceholderText(/Tài khoản SA/i), 'sa');
  await userEvent.type(screen.getByPlaceholderText(/Mật khẩu/i), 'pw');
}

describe('SaLoginForm', () => {
  it('mặc định chỉ hiện link, bấm mới mở form', async () => {
    renderWithI18n(<SaLoginForm />);
    expect(
      screen.queryByPlaceholderText(/Tài khoản SA/i),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /SA nội bộ/i }));
    expect(screen.getByPlaceholderText(/Tài khoản SA/i)).toBeInTheDocument();
  });

  it('gửi đúng payload tới /api/auth/sa-login', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, {})));
    vi.stubGlobal('fetch', fetchMock);
    await openForm();
    await userEvent.click(screen.getByRole('button', { name: /Đăng nhập/i }));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/sa-login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'sa', password: 'pw' }),
      }),
    );
  });

  it('401 → thông điệp sai tài khoản/mật khẩu', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(401, { code: 'SA_LOGIN_INVALID' }))),
    );
    await openForm();
    await userEvent.click(screen.getByRole('button', { name: /Đăng nhập/i }));
    expect(await screen.findByText(/Sai tài khoản hoặc mật khẩu/i)).toBeInTheDocument();
  });

  it('429 → thông điệp khoá tạm', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(429, { code: 'SA_LOGIN_LOCKED' }))),
    );
    await openForm();
    await userEvent.click(screen.getByRole('button', { name: /Đăng nhập/i }));
    expect(await screen.findByText(/tạm khoá/i)).toBeInTheDocument();
  });
});
