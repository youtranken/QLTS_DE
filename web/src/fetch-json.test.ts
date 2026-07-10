import { describe, it, expect, vi } from 'vitest';
import { fetchJson } from './fetch-json';
import { jsonResponse } from './test/test-utils';

describe('fetchJson', () => {
  it('trả JSON đã parse khi response ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { hello: 'world' })));
    await expect(fetchJson<{ hello: string }>('/x')).resolves.toEqual({
      hello: 'world',
    });
  });

  it('NÉM lỗi kèm status khi !ok — không nuốt thành danh sách rỗng (P0)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})));
    await expect(fetchJson('/x')).rejects.toMatchObject({ status: 500 });
  });

  it('chuyển tiếp init (method/headers) xuống fetch', async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', spy);
    await fetchJson('/y', { method: 'POST' });
    expect(spy).toHaveBeenCalledWith('/y', { method: 'POST' });
  });
});
