import { Injectable } from '@nestjs/common';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { parseLocalSa } from './local-sa-env';
import type { LocalSaConfig } from './local-sa-env';

const KEYLEN = 64;
const SALT_BYTES = 16;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

/** Sinh hash lưu vào env: `scrypt.<saltHex>.<hashHex>` (dùng bởi `npm run sa:hash`). */
export function hashPassword(pw: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(pw, salt, KEYLEN);
  return `scrypt.${salt.toString('hex')}.${hash.toString('hex')}`;
}

/** So mật khẩu với hash đã lưu — timing-safe; sai định dạng → false. */
export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split('.');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length === 0) {
    return false;
  }
  const actual = scryptSync(pw, Buffer.from(parts[1], 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

type Attempt = { fails: number; lockUntil: number };

/**
 * Xác thực SA local (env-based, break-glass) + chống brute-force theo IP.
 * Lockout IN-MEMORY: đủ cho deploy single-instance hiện tại; scale nhiều instance
 * sau này → chuyển Redis (tech-debt, KHÔNG làm trong story này).
 */
@Injectable()
export class LocalSaService {
  private readonly config: LocalSaConfig | null = parseLocalSa(process.env);
  private readonly attempts = new Map<string, Attempt>();

  /**
   * Một lần thử đăng nhập từ `ip`:
   *  - 'locked'  → IP đang bị khoá tạm (429), KHÔNG kiểm credential
   *  - 'ok'      → đúng, reset bộ đếm IP
   *  - 'bad'     → sai (401), tăng bộ đếm (lần thứ 5 chuyển sang 'locked')
   * Luôn chạy scrypt (kể cả sai username) để không lộ enumeration qua timing.
   */
  attemptLogin(username: string, password: string, ip: string): 'ok' | 'bad' | 'locked' {
    const now = Date.now();
    const prev = this.attempts.get(ip);
    if (prev && prev.lockUntil > now) {
      return 'locked';
    }

    if (this.verifyCredentials(username, password)) {
      this.attempts.delete(ip);
      return 'ok';
    }

    // Bộ đếm mới nếu chưa có, hoặc lock trước đó đã hết hạn (lockUntil <= now)
    const fails = (prev && prev.lockUntil === 0 ? prev.fails : 0) + 1;
    if (fails >= MAX_FAILS) {
      this.attempts.set(ip, { fails: 0, lockUntil: now + LOCK_MS });
      return 'locked';
    }
    this.attempts.set(ip, { fails, lockUntil: 0 });
    return 'bad';
  }

  private verifyCredentials(username: string, password: string): boolean {
    if (!this.config) {
      return false;
    }
    const userMatch = username === this.config.username;
    // Chạy verify BẤT KỂ username đúng/sai — cân bằng thời gian
    const passMatch = verifyPassword(password, this.config.passwordHash);
    return userMatch && passMatch;
  }
}
