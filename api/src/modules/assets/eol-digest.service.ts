import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { SystemConfigService } from '../config/system-config.service';
import { MailSettingsService } from '../config/mail-settings.service';
import { OutboxService } from '../outbox/outbox.service';
import { SweepService } from '../queue/sweep.service';

/** Giờ VN 'HH:mm' hiện tại (so với giờ digest đã đặt). */
const vnNowHm = () =>
  new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23', // tránh biên '24:00' (một số ICU) làm gate sai lúc nửa đêm
  });

const TODAY_VN = sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

/**
 * Digest EOL — nhắc admin MÁY MỚI đủ tuổi thọ (asset_lifespan_years) cần thanh lý. Chỉ phát khi có
 * máy chưa từng báo (assets.eol_notified_at IS NULL); registrar đánh dấu sau khi gửi → máy đã báo mà
 * chưa thanh lý (còn "treo") KHÔNG bị nhắc lại. License sắp hết hạn có digest riêng (LicenseDigest).
 * Nhịp: MỖI TUẦN VN 1 lần (marker `eol_digest_sent_week` = IYYY-IW), sweep tự bù trong tuần nếu lỡ.
 */
@Injectable()
export class EolDigestService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly config: SystemConfigService,
    private readonly outbox: OutboxService,
    private readonly sweep: SweepService,
    private readonly mailSettings: MailSettingsService,
  ) {}

  onModuleInit(): void {
    this.sweep.register({
      name: 'eol-digest',
      run: async () => {
        await this.emitEolDigest();
      },
    });
  }

  async emitEolDigest(): Promise<boolean> {
    // Tắt ở Cấu hình thông báo → bỏ TRƯỚC khi claim marker tuần (khỏi "đốt" mốc → bật lại
    // trong tuần vẫn gửi — review Med 2026-07-31).
    if (!(await this.mailSettings.isEnabled('eol_digest'))) return false;
    if (vnNowHm() < (await this.mailSettings.getDigestTime())) return false;
    const lifespanYears = await this.config.getAssetLifespanYears();
    // Chỉ phát khi có máy MỚI đủ tuổi (eol_notified_at IS NULL). Máy đã báo mà chưa thanh lý
    // (còn "treo") không kích hoạt lại → hết cảnh báo trùng mỗi tuần cho cùng danh sách.
    const any = await this.db.execute<{ e: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM assets a
        WHERE a.type <> 'software' AND a.status <> 'disposed' AND a.purged_at IS NULL
          AND a.eol_notified_at IS NULL
          AND a.start_date IS NOT NULL
          AND a.start_date <= (${TODAY_VN} - make_interval(years => ${lifespanYears}::int))::date
      ) AS e
    `);
    if (!any.rows[0]?.e) return false;

    return this.db.transaction(async (tx) => {
      // Claim 1 digest/TUẦN VN (chống sweep đúp): 0 dòng = đã gửi tuần này.
      const claim = await tx.execute<{ key: string }>(sql`
        WITH wk AS (SELECT to_char(${TODAY_VN}, 'IYYY-IW') AS k)
        INSERT INTO config (key, value)
        SELECT 'eol_digest_sent_week', to_jsonb(wk.k) FROM wk
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          WHERE config.value IS DISTINCT FROM EXCLUDED.value
        RETURNING key
      `);
      if (claim.rows.length !== 1) return false;
      await this.outbox.enqueueWithin(tx, 'eol_digest', {});
      return true;
    });
  }
}
