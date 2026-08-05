import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { OutboxService } from '../outbox/outbox.service';

/**
 * Nhắc "tới hạn trả" — gửi MỘT LẦN đúng thời điểm hết hạn buổi mượn (upper(period) đã tới).
 * Sweep: buổi `delivered` của ticket `in_use`, đã tới hạn, chưa gửi (due_notified_at IS NULL)
 * → phát `due_reminder` cho Admin + người mượn, đóng dấu marker cấp booking để không lặp.
 * Khác 5.3 (quá hạn, nhắc mỗi ngày): đây là 1 mail báo "đến giờ trả". File riêng (granularity).
 */
@Injectable()
export class DueReminderService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly outbox: OutboxService,
  ) {}

  async emitDueReminders(): Promise<number> {
    // Bỏ mail với ca mượn TRONG NGÀY (ngày nhận = ngày trả, giờ VN): nhắc tới hạn thừa.
    const notSameDay = sql`(lower(b.period) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      <> (upper(b.period) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
    const rows = await this.db.execute<{ id: string; ticket_id: string }>(sql`
      SELECT b.id, b.ticket_id
      FROM booking b JOIN ticket t ON t.id = b.ticket_id
      WHERE b.state = 'delivered' AND b.due_notified_at IS NULL
        AND upper(b.period) <= now()
        AND t.state = 'in_use'
        AND ${notSameDay}
    `);

    let n = 0;
    for (const r of rows.rows) {
      const done = await this.db.transaction(async (tx) => {
        const upd = await tx.execute<{ id: string }>(sql`
          UPDATE booking SET due_notified_at = now()
          WHERE id = ${r.id} AND state = 'delivered' AND due_notified_at IS NULL
            AND upper(period) <= now()
          RETURNING id
        `);
        if (upd.rows.length !== 1) return false;
        await this.outbox.enqueueWithin(tx, 'due_reminder', {
          bookingId: r.id,
          ticketId: r.ticket_id,
        });
        return true;
      });
      if (done) n++;
    }
    return n;
  }
}
