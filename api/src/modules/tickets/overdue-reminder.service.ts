import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { OutboxService } from '../outbox/outbox.service';
import { vnDateString } from './working-hours';

/**
 * Nhắc quá hạn hằng ngày (5.3, AD-9). 5.3 là CHỦ DUY NHẤT của nhịp mail quá hạn — 3.8 chỉ bật
 * cờ `is_overdue`, không phát sự kiện. Sweep: ticket `in_use` còn cờ quá hạn → phát
 * `overdue_reminder`, 1 mail/ngày VN (marker `overdue_reminder_date`). Nhịp derive DB (không
 * tin cron slot); close → cờ gỡ + rời in_use → dừng ngay. File riêng (granularity).
 */
@Injectable()
export class OverdueReminderService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly outbox: OutboxService,
  ) {}

  async emitOverdueReminders(): Promise<number> {
    const today = vnDateString(new Date());
    // EXISTS buổi THỰC quá hạn (không chỉ cờ ticket): với chuỗi định kỳ, `is_overdue` cấp
    // ticket chỉ gỡ khi close — 1 buổi đã trả để lại cờ stale. Không có ràng buộc này thì
    // marker ngày bị "đốt" vào ngày không có buổi quá hạn → trễ mail buổi quá hạn sau (review M1).
    const overdueSession = sql`EXISTS (
      SELECT 1 FROM booking b
      WHERE b.ticket_id = ticket.id AND b.state = 'delivered' AND upper(b.period) < now()
    )`;
    const rows = await this.db.execute<{ id: string }>(sql`
      SELECT id FROM ticket
      WHERE state = 'in_use' AND is_overdue = true
        AND (overdue_reminder_date IS NULL OR overdue_reminder_date < ${today})
        AND ${overdueSession}
    `);

    let n = 0;
    for (const r of rows.rows) {
      const done = await this.db.transaction(async (tx) => {
        const upd = await tx.execute<{ id: string }>(sql`
          UPDATE ticket SET overdue_reminder_date = ${today}
          WHERE id = ${r.id} AND state = 'in_use' AND is_overdue = true
            AND (overdue_reminder_date IS NULL OR overdue_reminder_date < ${today})
            AND EXISTS (
              SELECT 1 FROM booking b
              WHERE b.ticket_id = ticket.id AND b.state = 'delivered'
                AND upper(b.period) < now()
            )
          RETURNING id
        `);
        if (upd.rows.length !== 1) return false;
        await this.outbox.enqueueWithin(tx, 'overdue_reminder', {
          ticketId: r.id,
        });
        return true;
      });
      if (done) n++;
    }
    return n;
  }
}
