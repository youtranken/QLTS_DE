import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { MailTransportService } from './mail-transport.service';
import { NotificationRecipientsService } from './notification-recipients.service';
import { NotificationsConsumer } from './notifications.consumer';

interface ApprovalTicket {
  borrowerSub: string;
  fullName: string | null;
  state: string;
  createdAt: Date;
}

/** Thời điểm tạo request theo giờ VN (đưa vào mail — AC1 "người mượn + thời điểm"). */
function vnDateTime(d: Date): string {
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

/**
 * Luật mail duyệt (5.2, AD-11) — gắn 2 handler vào consumer: `approval_requested` (mail ngay khi
 * có request cần duyệt) + `approval_reminder` (nhắc treo). Consumer đọc lại DB theo id (payload
 * chỉ ref). Đăng ký OnModuleInit — chạy ở cả api lẫn worker (register vô hại ở api).
 */
@Injectable()
export class ApprovalMailRegistrar implements OnModuleInit {
  private readonly logger = new Logger(ApprovalMailRegistrar.name);

  constructor(
    private readonly consumer: NotificationsConsumer,
    private readonly recipients: NotificationRecipientsService,
    @Inject(DRIZZLE_DB) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.consumer.register('approval_requested', (ctx) =>
      this.send(ctx.payload, ctx.mail, 'requested'),
    );
    this.consumer.register('approval_reminder', (ctx) =>
      this.send(ctx.payload, ctx.mail, 'reminder'),
    );
  }

  private async loadTicket(id: string): Promise<ApprovalTicket | null> {
    const r = await this.db.execute<{
      borrower_sub: string;
      full_name: string | null;
      state: string;
      created_at: Date;
    }>(sql`
      SELECT t.borrower_sub, t.state, t.created_at, u.full_name
      FROM ticket t LEFT JOIN users u ON u.sub = t.borrower_sub
      WHERE t.id = ${id}
    `);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      borrowerSub: row.borrower_sub,
      fullName: row.full_name,
      state: row.state,
      createdAt: new Date(row.created_at),
    };
  }

  private async send(
    payload: Record<string, unknown>,
    mail: MailTransportService,
    kind: 'requested' | 'reminder',
  ): Promise<void> {
    const ticketId =
      typeof payload.ticketId === 'string' ? payload.ticketId : '';
    if (!ticketId) return;
    const t = await this.loadTicket(ticketId);
    // Đã duyệt/từ chối trong khe relay → không mail lỗi thời (AC3).
    if (!t || t.state !== 'pending_approval') return;
    const to = await this.recipients.adminEmails();
    if (to.length === 0) {
      this.logger.warn('không có email admin — bỏ qua mail duyệt');
      return;
    }
    const link = `${process.env.APP_BASE_URL ?? 'http://localhost:8080'}/xu-ly-muon`;
    const who = t.fullName ?? t.borrowerSub;
    const at = vnDateTime(t.createdAt);
    const subject =
      kind === 'requested'
        ? 'QLTS: Có yêu cầu mượn cần duyệt'
        : 'QLTS: Nhắc duyệt — yêu cầu mượn treo quá hạn';
    const text =
      kind === 'requested'
        ? `Có yêu cầu mượn cần duyệt từ ${who} (gửi lúc ${at}).\nXem và xử lý: ${link}`
        : `Yêu cầu mượn từ ${who} (gửi lúc ${at}) đã treo quá thời gian quy định, vui lòng duyệt.\nXem: ${link}`;
    await mail.send({ to, subject, text });
  }
}
