import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { configTable } from './config.schema';
import {
  SystemConfigService,
  type WorkingHours,
} from './system-config.service';

/** 7 tham số FR-44 SA chỉnh (6.3) — whitelist, KHÔNG gồm marker runtime (baseline/sync). */
const EDITABLE_KEYS = [
  'booking_window_days',
  'active_ticket_quota',
  'extension_days_per_grant',
  'extension_max_grants',
  'license_warning_days',
  'working_hours',
  'approval_reminder_working_hours',
  'auto_approve_max_hours',
] as const;

export interface ConfigPatch {
  booking_window_days?: number;
  active_ticket_quota?: number;
  extension_days_per_grant?: number;
  extension_max_grants?: number;
  license_warning_days?: number;
  approval_reminder_working_hours?: number;
  auto_approve_max_hours?: number;
  working_hours?: WorkingHours;
}

const INVALID = (message: string) =>
  new BadRequestException({ code: 'CONFIG_INVALID', message });

@Injectable()
export class ConfigAdminService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
    private readonly config: SystemConfigService,
  ) {}

  /** 8 tham số hiện hành cho màn SA (AC1) — chỉ EDITABLE, không marker runtime. */
  async listEditable(): Promise<Record<string, unknown>> {
    const rows = await this.db
      .select({ key: configTable.key, value: configTable.value })
      .from(configTable)
      .where(inArray(configTable.key, [...EDITABLE_KEYS]));
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async update(
    patch: ConfigPatch,
    actorSub: string,
  ): Promise<Record<string, unknown>> {
    const entries = Object.entries(patch).filter(
      ([k, v]) =>
        (EDITABLE_KEYS as readonly string[]).includes(k) && v !== undefined,
    );
    if (entries.length === 0) {
      throw INVALID('Không có tham số hợp lệ để cập nhật.');
    }
    // Ngoài biên số (class-validator ở DTO): working_hours cần end > start + days hợp lệ.
    if (patch.working_hours) {
      this.assertWorkingHours(patch.working_hours);
      // tz cố định VN: mọi consumer (working-hours.ts) hardcode Asia/Ho_Chi_Minh — không cho
      // SA lưu tz "sửa được nhưng vô tác dụng" (review 6.3 M1). Giữ field hợp lệ cho getWorkingHours.
      patch.working_hours.tz = 'Asia/Ho_Chi_Minh';
    }

    await this.db.transaction(async (tx) => {
      for (const [key, value] of entries) {
        const old = await tx
          .select({ value: configTable.value })
          .from(configTable)
          .where(inArray(configTable.key, [key]));
        await tx
          .update(configTable)
          .set({ value: value as unknown, updatedAt: new Date() })
          .where(inArray(configTable.key, [key]));
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'config.update',
          objectType: 'config',
          objectId: key,
          detail: { from: old[0]?.value ?? null, to: value },
        });
      }
    });
    // Hiệu lực NGAY (không chờ TTL 30s) — mọi module đọc SystemConfigService thấy giá trị mới.
    this.config.clearCache();
    return this.listEditable();
  }

  private assertWorkingHours(wh: WorkingHours): void {
    if (
      !Array.isArray(wh.days) ||
      wh.days.length === 0 ||
      wh.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
    ) {
      throw INVALID('working_hours.days phải là các ngày 1..7, không rỗng.');
    }
    const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!TIME.test(wh.start) || !TIME.test(wh.end)) {
      throw INVALID('working_hours.start/end phải dạng HH:MM hợp lệ.');
    }
    if (wh.end <= wh.start) {
      throw INVALID('working_hours.end phải sau start.');
    }
  }
}
