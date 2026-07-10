import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { parseBookingWindow } from '../../common/booking-window';
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

export interface BusyBlock {
  from: string;
  to: string;
  kind: string;
}

export interface MachineCalendar {
  assetId: string;
  code: string;
  weekStart: string;
  weekEnd: string;
  busy: BusyBlock[];
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
    typeFilter?: string | null,
  ): Promise<AvailableMachine[]> {
    const windowDays = await this.config.getBookingWindowDays();
    parseBookingWindow(fromIso, toIso, windowDays);

    // OCCUPYING_STATES từ nguồn chung (AD-2) — dựng list literal cho SQL, không hard-code lại
    const occupying = sql.join(
      OCCUPYING_STATES.map((s) => sql`${s}`),
      sql`, `,
    );
    // 7.3: lọc loại (tùy chọn) — bind param, chỉ thêm điều kiện HIỂN THỊ, không đổi occupy core.
    const typeCond = typeFilter ? sql`AND a.type = ${typeFilter}` : sql``;
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
        ${typeCond}
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

  /**
   * Distinct loại máy pool đang dùng (7.3) — nguồn cho dropdown lọc loại ở popup đặt máy.
   * Chỉ máy is_pool + in_use (loại thực sự đặt được). Read-model công khai nội bộ (AD-5).
   */
  async assetTypes(): Promise<string[]> {
    const rows = await this.db.execute<{ type: string }>(sql`
      SELECT DISTINCT type FROM assets
      WHERE is_pool = true AND status = 'in_use'
      ORDER BY type
    `);
    return rows.rows.map((r) => r.type);
  }

  /**
   * Máy pool đang RẢNH ngay bây giờ (9.5) — nguồn cho bảng "Máy có thể mượn" ở trang chủ.
   * = is_pool + in_use, không có booking chiếm chỗ chồng lên thời điểm hiện tại.
   * Read-model công khai nội bộ (AD-5) — không lộ người mượn.
   */
  async poolFreeNow(): Promise<
    Array<{ id: string; code: string; type: string; configuration: string | null }>
  > {
    const occupying = sql.join(
      OCCUPYING_STATES.map((s) => sql`${s}`),
      sql`, `,
    );
    const rows = await this.db.execute<{
      id: string;
      code: string;
      type: string;
      configuration: string | null;
    }>(sql`
      SELECT a.id, a.code, a.type, a.configuration
      FROM assets a
      WHERE a.is_pool = true AND a.status = 'in_use'
        AND NOT EXISTS (
          SELECT 1 FROM booking b
          WHERE b.asset_id = a.id
            AND b.state IN (${occupying})
            AND b.period @> now()
        )
      ORDER BY a.code
    `);
    return rows.rows;
  }

  /**
   * Lịch tuần của MỘT máy (FR-10): các khối busy = booking OCCUPYING chồng tuần đó.
   * AD-5 NGHIÊM NGẶT: payload chỉ khung giờ + kind — TUYỆT ĐỐI không borrower/lý do.
   * weekStart chuẩn hóa về Thứ 2 00:00 giờ VN (date_trunc('week') — tuần Postgres bắt đầu
   * Thứ 2, khớp ISO). weekStart null → tuần chứa hiện tại.
   */
  async machineCalendar(
    assetId: string,
    weekStartIso: string | null,
  ): Promise<MachineCalendar> {
    const asset = await this.db.execute<{ code: string }>(sql`
      SELECT code FROM assets WHERE id = ${assetId}
    `);
    if (asset.rows.length === 0) {
      throw new NotFoundException({
        code: 'ASSET_NOT_FOUND',
        message: 'Không tìm thấy máy này.',
      });
    }

    // Neo tuần theo giờ VN: date_trunc('week') trên timestamp-VN rồi gán lại timezone VN
    // → tstz đúng mốc Thứ 2 00:00 Asia/Ho_Chi_Minh, ổn định bất kể TZ server.
    const anchor = weekStartIso
      ? sql`${weekStartIso}::timestamptz`
      : sql`now()`;
    const occupying = sql.join(
      OCCUPYING_STATES.map((s) => sql`${s}`),
      sql`, `,
    );
    // ws_local: MỐc Thứ 2 00:00 dạng wall-clock VN (timestamp không tz). Cộng '7 days'
    // TRONG miền wall-clock (day-arithmetic, DST-agnostic) rồi mới AT TIME ZONE ra tstz —
    // độc lập session tz Postgres (robust dù deploy ở tz có DST — review 3.2 Low-2).
    const rows = await this.db.execute<{
      week_start: string;
      week_end: string;
      busy: BusyBlock[];
    }>(sql`
      WITH wk AS (
        SELECT date_trunc('week', (${anchor} AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS ws_local
      )
      SELECT
        (wk.ws_local AT TIME ZONE 'Asia/Ho_Chi_Minh') AS week_start,
        ((wk.ws_local + interval '7 days') AT TIME ZONE 'Asia/Ho_Chi_Minh') AS week_end,
        COALESCE(
          json_agg(json_build_object(
            'from', lower(b.period), 'to', upper(b.period), 'kind', b.kind
          ) ORDER BY lower(b.period)) FILTER (WHERE b.id IS NOT NULL),
          '[]'
        ) AS busy
      FROM wk
      LEFT JOIN booking b
        ON b.asset_id = ${assetId}
        AND b.state IN (${occupying})
        AND b.period && tstzrange(
          (wk.ws_local AT TIME ZONE 'Asia/Ho_Chi_Minh'),
          ((wk.ws_local + interval '7 days') AT TIME ZONE 'Asia/Ho_Chi_Minh'),
          '[)'
        )
      GROUP BY wk.ws_local
    `);
    const row = rows.rows[0];
    return {
      assetId,
      code: asset.rows[0].code,
      weekStart: new Date(row.week_start).toISOString(),
      weekEnd: new Date(row.week_end).toISOString(),
      busy: row.busy,
    };
  }
}
