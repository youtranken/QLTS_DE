import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { decryptSecret, encryptSecret, hasEncKey } from '../../common/crypto-secret';

const KEY = 'smtp_settings';

interface SmtpStored {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
  /** Mật khẩu ĐÃ mã hoá (AES-256-GCM). KHÔNG BAO GIỜ trả ra ngoài. */
  passEnc?: string | null;
}

export interface SmtpTransport {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface SmtpUpdate {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
  /** Chỉ đặt khi ĐỔI mật khẩu; rỗng/undefined = giữ nguyên. */
  pass?: string;
}

/**
 * Cấu hình SMTP lưu DB (config key `smtp_settings`) — mật khẩu MÃ HOÁ (crypto-secret), GET
 * KHÔNG bao giờ trả password (chỉ cờ `configured`). MailTransportService đọc getForTransport().
 * Khoá `smtp_settings` KHÔNG nằm trong EDITABLE_KEYS nên không lộ qua GET /admin/config chung.
 */
@Injectable()
export class SmtpConfigService {
  private readonly logger = new Logger(SmtpConfigService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
  ) {}

  private async raw(): Promise<SmtpStored | null> {
    const rows = await this.db.execute<{ value: SmtpStored }>(
      sql`SELECT value FROM config WHERE key = ${KEY}`,
    );
    return rows.rows[0]?.value ?? null;
  }

  /** Cho màn cấu hình — KHÔNG có password. `configured`=đã có mật khẩu; `hasEncKey`=env sẵn sàng. */
  async get(): Promise<{
    host: string;
    port: number;
    secure: boolean;
    user: string;
    from: string;
    configured: boolean;
    hasEncKey: boolean;
  }> {
    const s = await this.raw();
    return {
      host: s?.host ?? '',
      port: s?.port ?? 587,
      secure: s?.secure ?? false,
      user: s?.user ?? '',
      from: s?.from ?? '',
      configured: !!s?.passEnc,
      hasEncKey: hasEncKey(),
    };
  }

  /**
   * Cho MailTransportService — giải mã password. Trả null (→ để MailTransport fallback env) khi:
   * chưa có host; cấu hình DỞ DANG (có user nhưng chưa có mật khẩu → đừng gửi auth rỗng); hoặc
   * giải mã HỎNG (đổi/mất MAIL_ENC_KEY). KHÔNG ném — ném sẽ giết TOÀN BỘ pipeline mail (?? không
   * bắt được exception ở MailTransport).
   */
  async getForTransport(): Promise<SmtpTransport | null> {
    const s = await this.raw();
    if (!s?.host) return null;
    if (s.user && !s.passEnc) return null; // cấu hình dở → fallback env
    let pass = '';
    if (s.passEnc) {
      try {
        pass = decryptSecret(s.passEnc);
      } catch (e) {
        this.logger.error(
          `Giải mã SMTP passEnc thất bại (kiểm tra MAIL_ENC_KEY) — bỏ qua cấu hình DB: ${(e as Error).message}`,
        );
        return null;
      }
    }
    return {
      host: s.host,
      port: Number(s.port) || 587,
      secure: s.secure ?? false,
      user: s.user ?? '',
      pass,
      from: s.from ?? '',
    };
  }

  async update(patch: SmtpUpdate, actorSub: string): Promise<void> {
    // Trim → password toàn khoảng trắng = KHÔNG đổi (khỏi ghi đè secret thật bằng rác).
    const pass = patch.pass?.trim() ?? '';
    if (pass && !hasEncKey()) {
      throw new BadRequestException({
        code: 'MAIL_ENC_KEY_MISSING',
        message: 'MAIL_ENC_KEY chưa cấu hình trên server — không lưu được mật khẩu SMTP.',
      });
    }
    const cur = (await this.raw()) ?? {};
    const next: SmtpStored = {
      host: (patch.host ?? cur.host ?? '').trim(),
      port: patch.port ?? cur.port ?? 587,
      secure: patch.secure ?? cur.secure ?? false,
      user: (patch.user ?? cur.user ?? '').trim(),
      from: (patch.from ?? cur.from ?? '').trim(),
      // Chỉ mã hoá lại khi có mật khẩu MỚI (đã trim); bỏ trống = giữ mật khẩu cũ.
      passEnc: pass ? encryptSecret(pass) : (cur.passEnc ?? null),
    };
    await this.db.execute(sql`
      INSERT INTO config (key, value) VALUES (${KEY}, ${JSON.stringify(next)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `);
    // Audit KHÔNG log password (chỉ ghi các trường không nhạy cảm + cờ đổi pass).
    await this.audit.append({
      actor: actorSub,
      action: 'config.smtp_update',
      objectType: 'config',
      objectId: KEY,
      detail: {
        host: next.host,
        port: next.port,
        secure: next.secure,
        user: next.user,
        from: next.from,
        passwordChanged: !!pass,
      },
    });
  }
}
