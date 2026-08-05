import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { parseBookingWindow } from '../../common/booking-window';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { SystemConfigService } from '../config/system-config.service';
import { OCCUPYING_STATES } from '../tickets/ticket-states';

/**
 * Tên các phần mềm đang cài trên máy `a` (gộp thành 1 chuỗi ", ") — hover xem nhanh ở
 * danh sách Mượn máy thay cho cấu hình. Loại bản đã thanh lý/xóa vĩnh viễn.
 */
const installedSoftwareNames = sql`(
  SELECT string_agg(sw.license_name, ', ' ORDER BY sw.license_name)
  FROM assets sw
  WHERE sw.installed_on_asset_id = a.id
    AND sw.type = 'software'
    AND sw.status <> 'disposed'
    AND sw.purged_at IS NULL
) AS software`;

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

/** Busy block trong lịch tổng — kèm state để FE phân loại "đang mượn"/"chờ duyệt". KHÔNG lộ người mượn (AD-5). */
export interface PoolBusyBlock {
  from: string;
  to: string;
  kind: string;
  state: string;
}
export interface PoolCalendarMachine {
  id: string;
  code: string | null;
  type: string;
  configuration: string | null;
  software: string | null;
  busy: PoolBusyBlock[];
}
export interface PoolCalendar {
  weekStart: string;
  weekEnd: string;
  machines: PoolCalendarMachine[];
}

export interface FreeSlot {
  from: string; // 'HH:MM' giờ VN
  to: string;
}
export interface DayMachineSlots {
  code: string | null;
  type: string;
  freeSlots: FreeSlot[];
}
export interface DayAvailability {
  date: string;
  isWorkingDay: boolean;
  start: string; // giờ làm HH:MM
  end: string;
  machines: DayMachineSlots[];
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
    const maxDurationHours = await this.config.getMaxBookingDurationHours();
    parseBookingWindow(
      fromIso,
      toIso,
      windowDays,
      Date.now(),
      maxDurationHours,
    );

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
   * KHUNG GIỜ trống của các máy pool trong MỘT ngày (cho câu "ngày X giờ nào trống").
   * Khe trống = giờ làm (config) − các block bận (booking chiếm chỗ). Read-model AD-5.
   */
  async dayFreeSlots(
    dateYmd: string,
    typeFilter?: string | null,
  ): Promise<DayAvailability> {
    const wh = await this.config.getWorkingHours();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
      throw new BadRequestException('Ngày không hợp lệ (cần YYYY-MM-DD).');
    }
    const [y, m, d] = dateYmd.split('-').map(Number);
    // ISO weekday (1=T2..7=CN) thuần lịch, không phụ thuộc TZ máy chủ.
    const isoWeekday =
      ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
    if (!wh.days.includes(isoWeekday)) {
      return {
        date: dateYmd,
        isWorkingDay: false,
        start: wh.start,
        end: wh.end,
        machines: [],
      };
    }
    const workStart = `${dateYmd}T${wh.start}:00+07:00`;
    const workEnd = `${dateYmd}T${wh.end}:00+07:00`;
    const occupying = sql.join(
      OCCUPYING_STATES.map((s) => sql`${s}`),
      sql`, `,
    );
    const typeCond = typeFilter ? sql`AND a.type = ${typeFilter}` : sql``;
    const rows = await this.db.execute<{
      code: string | null;
      type: string;
      busy: { from: string; to: string }[];
    }>(sql`
      SELECT a.code, a.type,
        COALESCE(
          json_agg(json_build_object('from', lower(b.period), 'to', upper(b.period))
            ORDER BY lower(b.period)) FILTER (WHERE b.id IS NOT NULL),
          '[]'
        ) AS busy
      FROM assets a
      LEFT JOIN booking b
        ON b.asset_id = a.id AND b.state IN (${occupying})
        AND b.period && tstzrange(${workStart}, ${workEnd}, '[)')
      WHERE a.is_pool = true AND a.status = 'in_use' AND a.type <> 'software'
        ${typeCond}
      GROUP BY a.id, a.code, a.type
      ORDER BY a.code
    `);
    const wsMs = new Date(workStart).getTime();
    const weMs = new Date(workEnd).getTime();
    return {
      date: dateYmd,
      isWorkingDay: true,
      start: wh.start,
      end: wh.end,
      machines: rows.rows.map((r) => ({
        code: r.code,
        type: r.type,
        freeSlots: computeFreeSlots(wsMs, weMs, r.busy),
      })),
    };
  }

  /**
   * Máy pool đang RẢNH ngay bây giờ (9.5) — nguồn cho bảng "Máy có thể mượn" ở trang chủ.
   * = is_pool + in_use, không có booking chiếm chỗ chồng lên thời điểm hiện tại.
   * Read-model công khai nội bộ (AD-5) — không lộ người mượn.
   */
  async poolFreeNow(): Promise<
    Array<{
      id: string;
      code: string;
      type: string;
      configuration: string | null;
      software: string | null;
    }>
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
      software: string | null;
    }>(sql`
      SELECT a.id, a.code, a.type, a.configuration, ${installedSoftwareNames}
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
   * TẤT CẢ máy pool + trạng thái (Phase 1b) — catalog Mượn máy hiện cả máy RẢNH lẫn máy
   * BẬN kèm "bận đến …". busyUntil = giờ kết thúc booking đang chiếm chỗ (null = rảnh ngay).
   * Read-model công khai nội bộ (AD-5) — KHÔNG lộ người mượn, chỉ khung giờ.
   */
  async poolAllWithStatus(): Promise<
    Array<{
      id: string;
      code: string;
      type: string;
      configuration: string | null;
      software: string | null;
      busyUntil: string | null;
    }>
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
      software: string | null;
      busy_until: string | null;
    }>(sql`
      SELECT a.id, a.code, a.type, a.configuration, ${installedSoftwareNames},
        (SELECT upper(b.period)
           FROM booking b
          WHERE b.asset_id = a.id
            AND b.state IN (${occupying})
            AND b.period @> now()
          ORDER BY upper(b.period) DESC
          LIMIT 1) AS busy_until
      FROM assets a
      WHERE a.is_pool = true AND a.status = 'in_use'
      ORDER BY busy_until NULLS FIRST, a.code
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      code: r.code,
      type: r.type,
      configuration: r.configuration,
      software: r.software,
      busyUntil: r.busy_until,
    }));
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

  /**
   * Các NGÀY (giờ VN) máy đã bận trong [from,to) — để FE khóa ngày trùng trên DatePicker.
   * Nở mỗi booking OCCUPYING thành các ngày nó chiếm (trừ 1µs ở biên trên để booking kết
   * đúng nửa đêm không "ăn" sang ngày sau). AD-5: chỉ trả NGÀY, không lộ người/khung giờ.
   */
  async busyDates(
    assetId: string,
    fromIso: string,
    toIso: string,
  ): Promise<string[]> {
    const occupying = sql.join(
      OCCUPYING_STATES.map((s) => sql`${s}`),
      sql`, `,
    );
    const rows = await this.db.execute<{ day: string }>(sql`
      SELECT DISTINCT to_char(d, 'YYYY-MM-DD') AS day
      FROM booking b
      CROSS JOIN LATERAL generate_series(
        date_trunc('day', lower(b.period) AT TIME ZONE 'Asia/Ho_Chi_Minh'),
        date_trunc('day', (upper(b.period) - interval '1 microsecond') AT TIME ZONE 'Asia/Ho_Chi_Minh'),
        interval '1 day'
      ) AS d
      WHERE b.asset_id = ${assetId}
        AND b.state IN (${occupying})
        AND b.period && tstzrange(${fromIso}::timestamptz, ${toIso}::timestamptz, '[)')
      ORDER BY day
    `);
    return rows.rows.map((r) => r.day);
  }

  /**
   * Lịch tuần TỔNG của mọi máy pool (mục sidebar "Lịch máy") — 1 hàng/máy, 7 cột ngày.
   * Neo tuần theo giờ VN như machineCalendar. AD-5: chỉ trạng thái bận + kind/state,
   * TUYỆT ĐỐI không tên người mượn. weekStart null → tuần hiện tại.
   */
  async poolCalendar(weekStartIso: string | null): Promise<PoolCalendar> {
    const anchor = weekStartIso
      ? sql`${weekStartIso}::timestamptz`
      : sql`now()`;
    const occupying = sql.join(
      OCCUPYING_STATES.map((s) => sql`${s}`),
      sql`, `,
    );
    const rows = await this.db.execute<{
      id: string;
      code: string | null;
      type: string;
      configuration: string | null;
      software: string | null;
      week_start: string;
      week_end: string;
      busy: PoolBusyBlock[];
    }>(sql`
      WITH wk AS (
        SELECT date_trunc('week', (${anchor} AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS ws_local
      ),
      bounds AS (
        SELECT
          (ws_local AT TIME ZONE 'Asia/Ho_Chi_Minh') AS ws,
          -- Lịch máy tổng: hiển thị 14 ngày (2 tuần) từ Thứ 2 mốc.
          ((ws_local + interval '14 days') AT TIME ZONE 'Asia/Ho_Chi_Minh') AS we
        FROM wk
      )
      SELECT a.id, a.code, a.type, a.configuration, ${installedSoftwareNames},
        (SELECT ws FROM bounds) AS week_start,
        (SELECT we FROM bounds) AS week_end,
        COALESCE(
          json_agg(json_build_object(
            'from', lower(b.period), 'to', upper(b.period), 'kind', b.kind, 'state', b.state
          ) ORDER BY lower(b.period)) FILTER (WHERE b.id IS NOT NULL),
          '[]'
        ) AS busy
      FROM assets a
      CROSS JOIN bounds
      LEFT JOIN booking b
        ON b.asset_id = a.id
        AND b.state IN (${occupying})
        AND b.period && tstzrange((SELECT ws FROM bounds), (SELECT we FROM bounds), '[)')
      WHERE a.is_pool = true AND a.type <> 'software' AND a.status <> 'disposed'
      GROUP BY a.id, a.code, a.type, a.configuration
      ORDER BY a.code
    `);
    if (rows.rows.length === 0) {
      // Không có máy pool: vẫn trả mốc tuần để FE hiện lịch rỗng đúng tuần.
      const b = await this.db.execute<{
        week_start: string;
        week_end: string;
      }>(sql`
        WITH wk AS (
          SELECT date_trunc('week', (${anchor} AT TIME ZONE 'Asia/Ho_Chi_Minh')) AS ws_local
        )
        SELECT (ws_local AT TIME ZONE 'Asia/Ho_Chi_Minh') AS week_start,
               ((ws_local + interval '14 days') AT TIME ZONE 'Asia/Ho_Chi_Minh') AS week_end
        FROM wk
      `);
      return {
        weekStart: new Date(b.rows[0].week_start).toISOString(),
        weekEnd: new Date(b.rows[0].week_end).toISOString(),
        machines: [],
      };
    }
    return {
      weekStart: new Date(rows.rows[0].week_start).toISOString(),
      weekEnd: new Date(rows.rows[0].week_end).toISOString(),
      machines: rows.rows.map((r) => ({
        id: r.id,
        code: r.code,
        type: r.type,
        configuration: r.configuration,
        software: r.software,
        busy: r.busy,
      })),
    };
  }
}

/** Khe trống trong [wsMs,weMs) sau khi trừ các block bận; trả 'HH:MM' giờ VN. */
export function computeFreeSlots(
  wsMs: number,
  weMs: number,
  busy: { from: string; to: string }[],
): FreeSlot[] {
  const blocks = busy
    .map((b) => ({
      from: Math.max(new Date(b.from).getTime(), wsMs),
      to: Math.min(new Date(b.to).getTime(), weMs),
    }))
    .filter((b) => b.to > b.from)
    .sort((a, b) => a.from - b.from);
  const gaps: { from: number; to: number }[] = [];
  let cursor = wsMs;
  for (const b of blocks) {
    if (b.from > cursor) gaps.push({ from: cursor, to: b.from });
    cursor = Math.max(cursor, b.to);
  }
  if (cursor < weMs) gaps.push({ from: cursor, to: weMs });
  return gaps.map((g) => ({ from: hhmm(g.from), to: hhmm(g.to) }));
}

function hhmm(ms: number): string {
  const d = new Date(ms + 7 * 3600 * 1000); // +07:00 → đọc giờ VN qua getUTC*
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
