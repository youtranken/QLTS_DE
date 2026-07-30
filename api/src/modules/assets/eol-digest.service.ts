import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { SystemConfigService } from '../config/system-config.service';
import { OutboxService } from '../outbox/outbox.service';
import { SweepService } from '../queue/sweep.service';

const TODAY_VN = sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

/**
 * Digest EOL — nhắc admin định kỳ danh sách MÁY đã đủ tuổi thọ (asset_lifespan_years) cần thanh
 * lý. License sắp hết hạn ĐÃ có digest riêng (LicenseDigestService), nên digest này chỉ lo MÁY để
 * không gửi trùng. Nhịp: MỖI TUẦN VN 1 lần (marker `eol_digest_sent_week` = IYYY-IW), sweep tự bù
 * trong tuần nếu lỡ. Rỗng (không máy nào đủ tuổi) → không phát.
 */
@Injectable()
export class EolDigestService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly config: SystemConfigService,
    private readonly outbox: OutboxService,
    private readonly sweep: SweepService,
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
    const lifespanYears = await this.config.getAssetLifespanYears();
    const any = await this.db.execute<{ e: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM assets a
        WHERE a.type <> 'software' AND a.status <> 'disposed' AND a.purged_at IS NULL
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
