import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { SystemConfigService } from '../config/system-config.service';
import { OCCUPYING_STATES } from '../tickets/ticket-states';

export interface AvailableSoftware {
  id: string;
  code: string;
  licenseName: string | null;
  licenseType: string | null;
}

export interface AvailableMachine {
  id: string;
  code: string;
  type: string;
  configuration: string | null;
  brand: string | null;
  model: string | null;
  floor: string | null;
  software: AvailableSoftware[];
}

@Injectable()
export class BookingService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly config: SystemConfigService,
  ) {}

  /**
   * Máy pool rảnh trong khung [from,to) (FR-6). SELECT chỉ để HIỂN THỊ —
   * tính đúng cuối cùng do DB đảm bảo lúc INSERT booking (AD-2, story 3.1c).
   * Đọc bảng assets read-only (AD-1 read-only join) — không ghi.
   */
  async availableMachines(
    fromIso: string,
    toIso: string,
  ): Promise<AvailableMachine[]> {
    const from = new Date(fromIso);
    const to = new Date(toIso);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: 'Giờ mượn/trả không hợp lệ.',
      });
    }
    if (to.getTime() <= from.getTime()) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: 'Giờ trả phải sau giờ nhận.',
      });
    }
    if (from.getTime() < Date.now()) {
      throw new BadRequestException({
        code: 'PAST_PICKUP',
        message: 'Giờ nhận phải từ hiện tại trở đi.',
      });
    }
    const windowDays = await this.config.getBookingWindowDays();
    const windowEnd = Date.now() + windowDays * 24 * 60 * 60 * 1000;
    if (from.getTime() > windowEnd) {
      throw new BadRequestException({
        code: 'BOOKING_WINDOW',
        message: `Chỉ được đặt trong vòng ${windowDays} ngày tới.`,
      });
    }

    // OCCUPYING_STATES từ nguồn chung (AD-2) — dựng list literal cho SQL, không hard-code lại
    const occupying = sql.join(
      OCCUPYING_STATES.map((s) => sql`${s}`),
      sql`, `,
    );
    const rows = await this.db.execute<{
      id: string;
      code: string;
      type: string;
      configuration: string | null;
      brand: string | null;
      model: string | null;
      floor: string | null;
      software: AvailableSoftware[];
    }>(sql`
      SELECT a.id, a.code, a.type, a.configuration, a.brand, a.model, a.floor,
        COALESCE(
          json_agg(json_build_object(
            'id', s.id, 'code', s.code,
            'licenseName', s.license_name, 'licenseType', s.license_type
          ) ORDER BY s.code) FILTER (WHERE s.id IS NOT NULL),
          '[]'
        ) AS software
      FROM assets a
      LEFT JOIN assets s
        ON s.installed_on_asset_id = a.id AND s.status <> 'disposed'
      WHERE a.is_pool = true AND a.status = 'in_use'
        AND NOT EXISTS (
          SELECT 1 FROM booking b
          WHERE b.asset_id = a.id
            AND b.state IN (${occupying})
            AND b.period && tstzrange(${fromIso}, ${toIso}, '[)')
        )
      GROUP BY a.id
      ORDER BY a.code
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      code: r.code,
      type: r.type,
      configuration: r.configuration,
      brand: r.brand,
      model: r.model,
      floor: r.floor,
      software: r.software,
    }));
  }
}
