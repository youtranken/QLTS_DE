import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * Mã hoá secret ứng dụng (mật khẩu SMTP) để KHÔNG lưu plaintext trong DB. AES-256-GCM, khoá =
 * SHA-256(MAIL_ENC_KEY) → chấp nhận khoá env bất kỳ độ dài. Ciphertext = iv.tag.data (base64),
 * kèm authTag nên tự phát hiện sửa đổi. Khoá chỉ ở ENV (api+worker) — dump DB đơn thuần không giải
 * được. Đây là nhượng bộ có kiểm soát so với AD-13c (env-only), đổi lấy UI cấu hình SMTP.
 */
function key(): Buffer {
  const raw = process.env.MAIL_ENC_KEY;
  if (!raw) {
    throw new Error(
      'MAIL_ENC_KEY chưa cấu hình — không mã hoá/giải mã được secret SMTP.',
    );
  }
  return createHash('sha256').update(raw).digest();
}

export function hasEncKey(): boolean {
  return !!process.env.MAIL_ENC_KEY;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decryptSecret(enc: string): string {
  const [ivB, tagB, ctB] = enc.split('.');
  if (!ivB || !tagB || !ctB) throw new Error('Ciphertext SMTP sai định dạng.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
