import { describe, it, expect, vi } from 'vitest';
import { apiFetch, ApiError } from '@/api-client';
import { jsonResponse } from '@/test/test-utils';

describe('apiFetch', () => {
  it('trả JSON khi ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { a: 1 })));
    await expect(apiFetch<{ a: number }>('/x')).resolves.toEqual({ a: 1 });
  });

  it('ném ApiError kèm status + body khi !ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(409, { message: 'trùng' })),
    );
    const err = (await apiFetch('/x').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.body).toEqual({ message: 'trùng' });
  });

  it('401 → ném ApiError(401) (redirect tập trung)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, {})));
    await expect(apiFetch('/x')).rejects.toMatchObject({ status: 401 });
  });

  it('gắn Content-Type + X-CSRF-Token khi có body/csrf', async () => {
    const fn = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fn);
    await apiFetch('/x', {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      csrfToken: 'tok',
    });
    const init = fn.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-CSRF-Token']).toBe('tok');
  });
});
