import { QueryClient } from '@tanstack/react-query';

/** Lỗi HTTP mang theo status + body để caller/onError xử lý (vd đọc body.message). */
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Client fetch dùng chung (review nguyên tắc #2): tự set JSON header + X-CSRF-Token, ném
 * ApiError kèm status, và XỬ LÝ 401 TẬP TRUNG (redirect '/') — xoá các chỗ lặp
 * `window.location.href='/'` rải rác khắp trang.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { csrfToken?: string | null } = {},
): Promise<T> {
  const { csrfToken, headers, body, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    body,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...headers,
    },
  });
  if (res.status === 401) {
    window.location.href = '/';
    throw new ApiError(401, null);
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new ApiError(res.status, errBody);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Factory để app và test dùng client riêng (test tắt retry cho lỗi hiện ngay). */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 10_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export const queryClient = makeQueryClient();
