import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';

const KEY = 'mail_settings';

/**
 * Danh sách topic mail bật/tắt được ở UI (Cấu hình thông báo). Thứ tự này cũng là thứ tự
 * hiển thị trên trang FE. Thêm mail mới → thêm topic vào đây + i18n nhãn ở FE.
 */
export const MAIL_TOPICS = [
  'approval_requested',
  'approval_reminder',
  'request_rejected',
  'overdue_reminder',
  'pickup_reminder',
  'booking_cancelled',
  'ticket_force_cancelled',
  'offboard_alert',
  'license_digest',
  'eol_digest',
  'extension_requested',
  'extension_rejected',
] as const;

export type MailTopic = (typeof MAIL_TOPICS)[number];

interface MailSettingsStored {
  enabled?: Record<string, boolean>;
  /** Giờ gửi digest (license/EOL) theo giờ VN, dạng 'HH:mm'. Mặc định '00:00' = ngay sau nửa đêm. */
  digestTime?: string;
}

export interface MailSettingsView {
  enabled: Record<MailTopic, boolean>;
  digestTime: string;
}

const DEFAULT_TIME = '00:00';
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Cấu hình bật/tắt từng loại mail + giờ gửi digest — lưu 1 config row JSON `mail_settings`
 * (ngoài EDITABLE_KEYS, giống smtp_settings). VẮNG ROW = mặc định: mọi mail BẬT, digest 00:00
 * (đúng hành vi trước khi có tính năng này). Consumer đọc isEnabled() để chốt gửi hay không;
 * digest service đọc getDigestTime() để hoãn tới giờ đã đặt.
 */
@Injectable()
export class MailSettingsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
  ) {}

  private async raw(): Promise<MailSettingsStored | null> {
    const rows = await this.db.execute<{ value: MailSettingsStored }>(
      sql`SELECT value FROM config WHERE key = ${KEY}`,
    );
    return rows.rows[0]?.value ?? null;
  }

  /** Mặc định BẬT: chỉ tắt khi cờ set đúng `false`. */
  async isEnabled(topic: string): Promise<boolean> {
    const s = await this.raw();
    return s?.enabled?.[topic] !== false;
  }

  /** 'HH:mm' giờ VN; digest chỉ gửi khi giờ hiện tại ≥ mốc này. */
  async getDigestTime(): Promise<string> {
    const s = await this.raw();
    const t = s?.digestTime;
    return t && TIME_RE.test(t) ? t : DEFAULT_TIME;
  }

  async get(): Promise<MailSettingsView> {
    const s = await this.raw();
    const enabled = Object.fromEntries(
      MAIL_TOPICS.map((t) => [t, s?.enabled?.[t] !== false]),
    ) as Record<MailTopic, boolean>;
    return { enabled, digestTime: await this.getDigestTime() };
  }

  async update(
    patch: { enabled?: Record<string, boolean>; digestTime?: string },
    actorSub: string,
  ): Promise<MailSettingsView> {
    const cur = (await this.raw()) ?? {};
    const enabled: Record<string, boolean> = { ...(cur.enabled ?? {}) };
    if (patch.enabled) {
      for (const t of MAIL_TOPICS) {
        if (typeof patch.enabled[t] === 'boolean') enabled[t] = patch.enabled[t];
      }
    }
    const digestTime =
      patch.digestTime && TIME_RE.test(patch.digestTime)
        ? patch.digestTime
        : (cur.digestTime ?? DEFAULT_TIME);
    const next: MailSettingsStored = { enabled, digestTime };
    await this.db.execute(sql`
      INSERT INTO config (key, value) VALUES (${KEY}, ${JSON.stringify(next)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `);
    await this.audit.append({
      actor: actorSub,
      action: 'config.mail_settings_update',
      objectType: 'config',
      objectId: KEY,
      detail: { enabled, digestTime },
    });
    return this.get();
  }
}
