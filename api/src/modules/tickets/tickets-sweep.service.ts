import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { OutboxService } from '../outbox/outbox.service';

/**
 * Sweep định kỳ ticket (AD-14, 3.8/3.9): đánh dấu quá hạn (markOverdue), tự đóng no-show,
 * phát nhắc nhận máy. Idempotent, đồng hồ 1 nguồn = Postgres now(). Tách khỏi TicketsService
 * (mục 6) — chạy qua TicketsSweepRegistrar; TicketsService delegate giữ public API.
 */
@Injectable()
export class TicketsSweepService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
    private readonly outbox: OutboxService,
  ) {}

  async markOverdue(): Promise<number> {
    const res = await this.db.execute<{ id: string }>(sql`
      UPDATE ticket t SET is_overdue = true,
        overdue_marked_at = COALESCE(t.overdue_marked_at, now()),
        updated_at = now()
      WHERE t.state = 'in_use' AND t.is_overdue = false
        AND EXISTS (
          SELECT 1 FROM booking b
          WHERE b.ticket_id = t.id AND b.state = 'delivered'
            AND upper(b.period) < now()
        )
      RETURNING t.id
    `);
    return res.rows.length;
  }

  async autoCloseNoShow(): Promise<number> {
    const candidates = await this.db.execute<{ id: string }>(sql`
      SELECT t.id FROM ticket t
      WHERE t.state = 'awaiting_pickup' AND t.kind = 'normal'
        AND EXISTS (
          SELECT 1 FROM booking b
          WHERE b.ticket_id = t.id AND b.state = 'pending' AND upper(b.period) < now()
        )
    `);
    let n = 0;
    for (const c of candidates.rows) {
      const done = await this.db.transaction(async (tx) => {
        const r = await tx.execute<{
          state: string;
          expired: boolean | null;
        }>(sql`
          SELECT t.state,
            (SELECT bool_and(upper(b.period) < now()) FROM booking b
               WHERE b.ticket_id = t.id AND b.state = 'pending') AS expired
          FROM ticket t WHERE t.id = ${c.id} FOR UPDATE
        `);
        const row = r.rows[0];
        if (!row || row.state !== 'awaiting_pickup' || row.expired !== true) {
          return false;
        }
        await tx.execute(sql`
          UPDATE ticket SET state = 'closed', close_reason = 'no_show',
            closed_at = COALESCE(closed_at, now()),
            version = version + 1, updated_at = now()
          WHERE id = ${c.id}
        `);
        await tx.execute(sql`
          UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
          WHERE ticket_id = ${c.id} AND state = 'pending'
        `);
        await this.audit.appendWithin(tx, {
          actor: 'system',
          action: 'tickets.no_show',
          objectType: 'ticket',
          objectId: c.id,
          detail: { note: 'auto-close: no-show' },
        });
        return true;
      });
      if (done) n++;
    }
    return n;
  }

  async emitPickupReminders(): Promise<number> {
    const due = await this.db.execute<{ id: string; ticket_id: string }>(sql`
      SELECT b.id, b.ticket_id FROM booking b
      JOIN ticket t ON t.id = b.ticket_id AND t.state = 'awaiting_pickup'
      WHERE b.state = 'pending'
        AND lower(b.period) < now() AND upper(b.period) > now()
        AND b.pickup_reminder_at IS NULL
    `);
    let n = 0;
    for (const row of due.rows) {
      const done = await this.db.transaction(async (tx) => {
        // Marker null-check trong tx (khóa dòng) → 2 sweep song song không ghi đúp
        const upd = await tx.execute<{ id: string }>(sql`
          UPDATE booking SET pickup_reminder_at = now()
          WHERE id = ${row.id} AND state = 'pending' AND pickup_reminder_at IS NULL
          RETURNING id
        `);
        if (upd.rows.length !== 1) return false;
        await this.outbox.enqueueWithin(tx, 'pickup_reminder', {
          ticketId: row.ticket_id,
          bookingId: row.id,
        });
        return true;
      });
      if (done) n++;
    }
    return n;
  }
}
