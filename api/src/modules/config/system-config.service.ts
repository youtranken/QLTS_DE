import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { configTable } from './config.schema';

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
@Injectable()
export class SystemConfigService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

  private async get<T>(key: string): Promise<T> {
    const rows = await this.db
      .select({ value: configTable.value })
      .from(configTable)
      .where(eq(configTable.key, key));
    if (rows.length === 0) {
      throw new Error(
        `Thiếu tham số cấu hình '${key}' — kiểm tra seed migration 0001_config.sql`,
      );
    }
    return rows[0].value as T;
  }

  getBookingWindowDays(): Promise<number> {
    return this.get<number>('booking_window_days');
  }

  getActiveTicketQuota(): Promise<number> {
    return this.get<number>('active_ticket_quota');
  }

  getExtensionDaysPerGrant(): Promise<number> {
    return this.get<number>('extension_days_per_grant');
  }

  getExtensionMaxGrants(): Promise<number> {
    return this.get<number>('extension_max_grants');
  }

  getLicenseWarningDays(): Promise<number> {
    return this.get<number>('license_warning_days');
  }

  getWorkingHours(): Promise<WorkingHours> {
    return this.get<WorkingHours>('working_hours');
  }

  getApprovalReminderWorkingHours(): Promise<number> {
    return this.get<number>('approval_reminder_working_hours');
  }
}
