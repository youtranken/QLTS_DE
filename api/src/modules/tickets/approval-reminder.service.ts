import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { SystemConfigService } from '../config/system-config.service';
import { OutboxService } from '../outbox/outbox.service';
import { elapsedWorkingMinutes, vnDateString } from './working-hours';

/**
 * Nhắc duyệt request treo (5.2, AD-9). Sweep: ticket `pending_approval` treo quá ngưỡng giờ
 * LÀM VIỆC (config) → phát `approval_reminder`, 1 mail/ngày VN (marker `approval_reminder_date`).
 * Nhịp DERIVE TỪ DB (điều kiện marker + đủ giờ kiểm trong sweep), không tin cron slot. File
 * riêng — không nhồi vào tickets.service (granularity).
 */
@Injectable()
export class ApprovalReminderService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly config: SystemConfigService,
    private readonly outbox: OutboxService,
  ) {}

  async emitApprovalReminders(): Promise<number> {
    const wh = await this.config.getWorkingHours();
    const thresholdMin =
      (await this.config.getApprovalReminderWorkingHours()) * 60;
    const now = new Date();
    const today = vnDateString(now);

    const rows = await this.db.execute<{ id: string; created_at: Date }>(sql`
      SELECT id, created_at FROM ticket
      WHERE state = 'pending_approval'
        AND (approval_reminder_date IS NULL OR approval_reminder_date < ${today})
    `);

    let n = 0;
    for (const r of rows.rows) {
      const elapsed = elapsedWorkingMinutes(new Date(r.created_at), now, wh);
      if (elapsed < thresholdMin) continue;
      const done = await this.db.transaction(async (tx) => {
        // Null/date-check trong tx → 2 sweep song song không mail đúp; ticket vừa rời
        // pending (Admin duyệt) → 0 dòng, không phát.
        const upd = await tx.execute<{ id: string }>(sql`
          UPDATE ticket SET approval_reminder_date = ${today}
          WHERE id = ${r.id} AND state = 'pending_approval'
            AND (approval_reminder_date IS NULL OR approval_reminder_date < ${today})
          RETURNING id
        `);
        if (upd.rows.length !== 1) return false;
        await this.outbox.enqueueWithin(tx, 'approval_reminder', {
          ticketId: r.id,
        });
        return true;
      });
      if (done) n++;
    }
    return n;
  }
}
