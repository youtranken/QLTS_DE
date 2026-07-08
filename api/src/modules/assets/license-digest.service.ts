import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { expiringLicenseWhere } from '../../common/license-expiry';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { SystemConfigService } from '../config/system-config.service';
import { OutboxService } from '../outbox/outbox.service';
import { SweepService } from '../queue/sweep.service';

const DIGEST_MARKER_KEY = 'license_digest_sent_date';
const vnToday = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

/**
 * Digest license sắp hết hạn (5.6, AD-9). Sweep hằng ngày: nếu có ≥1 license chạm mốc → phát
 * ĐÚNG 1 `license_digest`/ngày VN (marker global `license_digest_sent_date`, ghi cùng tx outbox).
 * Nhịp derive DB (marker `≠ today` kiểm trong sweep) — lỡ giờ vẫn bù trong ngày.
 */
@Injectable()
export class LicenseDigestService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly config: SystemConfigService,
    private readonly outbox: OutboxService,
    private readonly sweep: SweepService,
  ) {}

  onModuleInit(): void {
    this.sweep.register({
      name: 'license-digest',
      run: async () => {
        await this.emitLicenseDigest();
      },
    });
  }

  async emitLicenseDigest(): Promise<boolean> {
    const warningDays = await this.config.getLicenseWarningDays();
    const any = await this.db.execute<{ e: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM assets a
        LEFT JOIN assets h ON h.id = a.installed_on_asset_id
        WHERE ${expiringLicenseWhere(warningDays)}
      ) AS e
    `);
    if (!any.rows[0]?.e) return false;

    const today = vnToday();
    return this.db.transaction(async (tx) => {
      // Conditional upsert: 0 dòng = đã gửi digest hôm nay (1 digest/ngày, chống sweep đúp).
      const claim = await tx.execute<{ key: string }>(sql`
        INSERT INTO config (key, value)
        VALUES (${DIGEST_MARKER_KEY}, to_jsonb(${today}::text))
        ON CONFLICT (key) DO UPDATE SET value = to_jsonb(${today}::text), updated_at = now()
          WHERE config.value #>> '{}' IS DISTINCT FROM ${today}
        RETURNING key
      `);
      if (claim.rows.length !== 1) return false;
      await this.outbox.enqueueWithin(tx, 'license_digest', {});
      return true;
    });
  }
}
