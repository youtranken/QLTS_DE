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

/** Ký tự hợp lệ của một `sub` (uuid hoặc dạng usr_xxx) — bắt lỗi gõ nhầm `;`/khoảng trắng giữa entry. */
const SUB_PATTERN = /^[A-Za-z0-9._~-]{8,}$/;

/** Boot-time assert (fail-closed): trống/sai định dạng → từ chối khởi động. */
export function assertSaSubsConfigured(env: EnvLike): void {
  const subs = parseSaSubs(env);
  if (env.SA_SUBS === undefined || subs.size === 0) {
    throw new Error(
      'SA_SUBS trống — phải là danh sách `sub` PMH ID phân cách dấu phẩy. ' +
        'Từ chối khởi động (không có cơ chế nâng SA ngầm).',
    );
  }
  const invalid = [...subs].filter((s) => !SUB_PATTERN.test(s));
  if (invalid.length > 0) {
    throw new Error(
      `SA_SUBS sai định dạng (entry không hợp lệ: ${invalid.join(' | ')}) — ` +
        'mỗi entry là một `sub` PMH ID, phân cách bằng DẤU PHẨY. Từ chối khởi động.',
    );
  }
}
