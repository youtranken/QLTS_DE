import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { MailTransportService } from './mail-transport.service';
import { NotificationsConsumer } from './notifications.consumer';

interface ForceCancelled {
  assetCode: string | null;
  from: Date | null;
  to: Date | null;
  borrowerEmail: string | null;
}

const vnTime = (d: Date | null) =>
  d ? d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '?';

/**
 * Mail báo lượt mượn bị Admin hủy CƯỠNG CHẾ (audit H-2). Khác `booking_cancelled`
 * (cascade máy hỏng/thanh lý — lý do derive từ trạng thái máy): ở đây lý do do Admin
 * GÕ TAY nên phải chuyển nguyên văn tới người mượn, không diễn giải lại.
 */
@Injectable()
export class ForceCancelMailRegistrar implements OnModuleInit {
  private readonly logger = new Logger(ForceCancelMailRegistrar.name);

  constructor(
    private readonly consumer: NotificationsConsumer,
    @Inject(DRIZZLE_DB) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.consumer.register('ticket_force_cancelled', (ctx) =>
      this.send(ctx.payload, ctx.mail),
    );
  }

  private async send(
    payload: Record<string, unknown>,
    mail: MailTransportService,
  ): Promise<void> {
    const ticketId =
      typeof payload.ticketId === 'string' ? payload.ticketId : '';
    const reason = typeof payload.reason === 'string' ? payload.reason : '';
    if (!ticketId) return;
    const t = await this.load(ticketId);
    if (!t) return;
    if (!t.borrowerEmail) {
      this.logger.warn('người mượn không có email — bỏ qua mail hủy cưỡng chế');
      return;
    }
    await mail.send({
      to: [t.borrowerEmail],
      subject: 'QLTS: Lượt mượn của bạn đã bị hủy',
      text:
        `Lượt đặt máy ${t.assetCode ?? '?'} khung ${vnTime(t.from)} – ${vnTime(t.to)} ` +
        `đã bị quản trị viên hủy.\n\nLý do: ${reason}\n\n` +
        `Nếu vẫn cần máy, vui lòng đặt lại hoặc liên hệ quản trị viên.`,
    });
  }

  private async load(ticketId: string): Promise<ForceCancelled | null> {
    // Booking đã bị set 'cancelled' cùng tx — lấy bản occupying gần nhất để có khung giờ.
    const r = await this.db.execute<{
      asset_code: string | null;
      from_at: Date | null;
      to_at: Date | null;
      email: string | null;
    }>(sql`
      SELECT a.code AS asset_code,
             lower(b.period) AS from_at, upper(b.period) AS to_at,
             u.email
      FROM ticket t
      LEFT JOIN booking b ON b.ticket_id = t.id AND b.kind = 'normal'
      LEFT JOIN assets a ON a.id = b.asset_id
      LEFT JOIN users u ON u.sub = t.borrower_sub
      WHERE t.id = ${ticketId}
      ORDER BY lower(b.period) DESC NULLS LAST
      LIMIT 1
    `);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      assetCode: row.asset_code,
      from: row.from_at ? new Date(row.from_at) : null,
      to: row.to_at ? new Date(row.to_at) : null,
      borrowerEmail: row.email && row.email !== '' ? row.email : null,
    };
  }
}
