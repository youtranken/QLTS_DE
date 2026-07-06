/**
 * SA từ env (story 1.5, FR-2): danh sách `sub` PMH ID trong SA_SUBS (phẩy).
 * CẤM nâng SA ngầm — SA CHỈ đến từ env; API đổi role không bao giờ nhận 'sa'.
 */
import type { EnvLike } from './auth-env';

export function parseSaSubs(env: EnvLike): Set<string> {
  const raw = env.SA_SUBS ?? '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Boot-time assert (fail-closed): trống/sai định dạng → từ chối khởi động. */
export function assertSaSubsConfigured(env: EnvLike): void {
  if (env.SA_SUBS === undefined || parseSaSubs(env).size === 0) {
    throw new Error(
      'SA_SUBS trống hoặc sai định dạng — phải là danh sách `sub` PMH ID phân cách dấu phẩy. ' +
        'Từ chối khởi động (không có cơ chế nâng SA ngầm).',
    );
  }
}
