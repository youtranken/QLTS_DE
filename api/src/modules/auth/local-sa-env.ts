/**
 * SA cục bộ (break-glass root) — thay cơ chế SA_SUBS (story 10.1).
 * SA KHÔNG còn suy ra từ `sub` SSO; SA = tài khoản local, credential trong env:
 *   LOCAL_SA_USERNAME      — tên đăng nhập SA
 *   LOCAL_SA_PASSWORD_HASH — `scrypt.<saltHex>.<hashHex>` (sinh bằng `npm run sa:hash`)
 * Dấu phân cách là '.' (KHÔNG dùng '$' — docker-compose diễn giải '$' là biến → hash hỏng).
 * Bất biến GIỮ NGUYÊN: "SA chỉ đến từ env" — DB bị xâm nhập không tạo được SA.
 */
import type { EnvLike } from './auth-env';

/** userSub cố định của phiên SSA local (không phải `sub` SSO, không có trong bảng users). */
export const LOCAL_SA_SUB = 'local:sa';

/** Tên hiển thị của SSA local trên identity/UI (bậc CAO NHẤT, trên admin). */
export const LOCAL_SA_FULL_NAME = 'SSA (nội bộ)';

/** Email danh tính SSA local (dùng cho hiển thị/audit; không phải hộp thư thật). */
export const LOCAL_SA_EMAIL = 'ssa@local.com';

/** Phiên SA local hết hạn theo idle ngắn (AC7) — 2 giờ kể từ last_seen_at. */
export const LOCAL_SA_IDLE_MS = 2 * 60 * 60 * 1000;

export interface LocalSaConfig {
  username: string;
  passwordHash: string;
}

/** Định dạng hash bắt buộc: scrypt.<saltHex>.<hashHex>. */
const HASH_PATTERN = /^scrypt\.[0-9a-f]+\.[0-9a-f]+$/i;

export function parseLocalSa(env: EnvLike): LocalSaConfig | null {
  const username = (env.LOCAL_SA_USERNAME ?? '').trim();
  const passwordHash = (env.LOCAL_SA_PASSWORD_HASH ?? '').trim();
  if (!username || !HASH_PATTERN.test(passwordHash)) {
    return null;
  }
  return { username, passwordHash };
}

/** Boot-time assert (fail-closed): thiếu username / hash sai định dạng → từ chối khởi động. */
export function assertLocalSaConfigured(env: EnvLike): void {
  const username = (env.LOCAL_SA_USERNAME ?? '').trim();
  const passwordHash = (env.LOCAL_SA_PASSWORD_HASH ?? '').trim();
  if (!username) {
    throw new Error(
      'LOCAL_SA_USERNAME trống — cần tên đăng nhập SA cục bộ (break-glass). ' +
        'Từ chối khởi động (không có cơ chế nâng SA ngầm).',
    );
  }
  if (!HASH_PATTERN.test(passwordHash)) {
    throw new Error(
      'LOCAL_SA_PASSWORD_HASH thiếu/sai định dạng — phải là `scrypt.<saltHex>.<hashHex>` ' +
        '(sinh bằng `npm run sa:hash`). Từ chối khởi động.',
    );
  }
}
