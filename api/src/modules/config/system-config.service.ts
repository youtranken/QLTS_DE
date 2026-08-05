import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { configTable } from './config.schema';

/** Key baseline consumer mail (5.1) — mốc bật consumer lần đầu, durable trong config. */
const MAIL_BASELINE_KEY = 'mail_consumer_baseline_at';
/** Mốc chạy full-sync danh bạ gần nhất (5.5) — ghi runtime. */
const DIRECTORY_SYNC_LAST_KEY = 'directory_sync_last_at';
/** Danh sách group được PMH ID gán cho client QLTS (10.2) — nguồn gate login, ghi từ directory-sync. */
const AUTHORIZED_GROUPS_KEY = 'authorized_groups';

export interface WorkingHours {
  tz: string;
  /** ISO weekday: 1 = Thứ 2 … 7 = Chủ nhật */
  days: number[];
  start: string;
  end: string;
}

/**
 * NGUỒN DUY NHẤT đọc tham số hệ thống FR-44 (AD-1: module khác inject service
 * này, không SELECT thẳng bảng config). Tên class tránh đụng @nestjs/config.
 */
/** TTL cache — hot path booking Epic 3 đọc quota/window mỗi request (defer 1.1, đến hạn). */
const CACHE_TTL_MS = 30_000;

@Injectable()
export class SystemConfigService {
  private readonly cache = new Map<
    string,
    { value: unknown; expires: number }
  >();

  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

  /** 6.3 (SA sửa config) PHẢI gọi sau khi ghi — hiệu lực ngay thay vì chờ TTL. */
  clearCache(): void {
    this.cache.clear();
  }

  private async get<T>(key: string): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
    const rows = await this.db
      .select({ value: configTable.value })
      .from(configTable)
      .where(eq(configTable.key, key));
    if (rows.length === 0) {
      throw new Error(
        `Thiếu tham số cấu hình '${key}' — kiểm tra seed migration 0001_config.sql`,
      );
    }
    this.cache.set(key, {
      value: rows[0].value,
      expires: Date.now() + CACHE_TTL_MS,
    });
    return rows[0].value as T;
  }

  /** Validate tại nguồn đọc (defer 1.1): jsonb không đảm bảo kiểu — số hỏng phải nổ RÕ. */
  private async getInt(key: string): Promise<number> {
    const raw = await this.get<unknown>(key);
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      throw new Error(
        `Tham số cấu hình '${key}' phải là số nguyên ≥ 0 (đang là ${JSON.stringify(raw)}).`,
      );
    }
    return n;
  }

  getBookingWindowDays(): Promise<number> {
    return this.getInt('booking_window_days');
  }

  getActiveTicketQuota(): Promise<number> {
    return this.getInt('active_ticket_quota');
  }

  getExtensionDaysPerGrant(): Promise<number> {
    return this.getInt('extension_days_per_grant');
  }

  getExtensionMaxGrants(): Promise<number> {
    return this.getInt('extension_max_grants');
  }

  getLicenseWarningDays(): Promise<number> {
    return this.getInt('license_warning_days');
  }

  /** Tuổi thọ máy (năm) — máy đủ tuổi → cảnh báo EOL/thanh lý. Mặc định 8 (0046). */
  getAssetLifespanYears(): Promise<number> {
    return this.getInt('asset_lifespan_years');
  }

  async getWorkingHours(): Promise<WorkingHours> {
    const raw = await this.get<WorkingHours>('working_hours');
    if (!raw || typeof raw.tz !== 'string' || !Array.isArray(raw.days)) {
      throw new Error(`Tham số cấu hình 'working_hours' sai cấu trúc.`);
    }
    return raw;
  }

  getApprovalReminderWorkingHours(): Promise<number> {
    return this.getInt('approval_reminder_working_hours');
  }

  /** Ngưỡng tự-duyệt (giờ): booking ≤ N vào thẳng awaiting_pickup, > N cần Admin duyệt (audit H2). */
  getAutoApproveMaxHours(): Promise<number> {
    return this.getInt('auto_approve_max_hours');
  }

  /** Trần thời lượng MỘT lượt mượn (audit H-2, 0041) — chặn booking giam máy vĩnh viễn. */
  getMaxBookingDurationHours(): Promise<number> {
    return this.getInt('max_booking_duration_hours');
  }

  /**
   * Baseline consumer mail (5.1, AC2) — ghi MỘT LẦN durable dùng `ON CONFLICT DO NOTHING`
   * (nhiều worker cùng boot không đè nhau). Lưu epoch millis để new Date() không mơ hồ định dạng.
   */
  async ensureMailConsumerBaseline(): Promise<Date> {
    await this.db.execute(sql`
      INSERT INTO config (key, value)
      VALUES (${MAIL_BASELINE_KEY}, to_jsonb((extract(epoch FROM now()) * 1000)::bigint))
      ON CONFLICT (key) DO NOTHING
    `);
    const at = await this.getMailConsumerBaselineAt();
    if (!at) {
      throw new Error('Không đọc được baseline consumer sau khi ghi.');
    }
    return at;
  }

  async getMailConsumerBaselineAt(): Promise<Date | null> {
    const rows = await this.db
      .select({ value: configTable.value })
      .from(configTable)
      .where(eq(configTable.key, MAIL_BASELINE_KEY));
    if (rows.length === 0) return null;
    return new Date(Number(rows[0].value));
  }

  /** Lịch sync danh bạ định kỳ (5.5, AC1) — seed 60 phút ở 0026. */
  getDirectorySyncIntervalMinutes(): Promise<number> {
    return this.getInt('directory_sync_interval_minutes');
  }

  /** Mốc chạy full-sync gần nhất (epoch millis) — derive lịch từ DB, không tin cron slot. */
  async getDirectorySyncLastAt(): Promise<Date | null> {
    const rows = await this.db
      .select({ value: configTable.value })
      .from(configTable)
      .where(eq(configTable.key, DIRECTORY_SYNC_LAST_KEY));
    if (rows.length === 0) return null;
    return new Date(Number(rows[0].value));
  }

  async setDirectorySyncLastAt(at: Date): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO config (key, value)
      VALUES (${DIRECTORY_SYNC_LAST_KEY}, to_jsonb(${at.getTime()}::bigint))
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `);
    this.cache.delete(DIRECTORY_SYNC_LAST_KEY);
  }

  /**
   * Group được phép vào QLTS (10.2) — nguồn động từ PMH ID `fetchGroups()`, ghi bởi
   * directory-sync. Đọc THẲNG (không cache/không throw): rỗng/chưa có → `[]` = gate TẮT
   * (fail-open trước lần sync đầu). An ninh cần tươi → không cache TTL.
   */
  async getAuthorizedGroups(): Promise<string[]> {
    const rows = await this.db
      .select({ value: configTable.value })
      .from(configTable)
      .where(eq(configTable.key, AUTHORIZED_GROUPS_KEY));
    if (rows.length === 0) {
      return [];
    }
    const value = rows[0].value;
    return Array.isArray(value)
      ? value.filter((x): x is string => typeof x === 'string')
      : [];
  }

  async setAuthorizedGroups(names: string[]): Promise<void> {
    const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
    await this.db.execute(sql`
      INSERT INTO config (key, value)
      VALUES (${AUTHORIZED_GROUPS_KEY}, ${JSON.stringify(clean)}::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `);
    this.cache.delete(AUTHORIZED_GROUPS_KEY);
  }
}
