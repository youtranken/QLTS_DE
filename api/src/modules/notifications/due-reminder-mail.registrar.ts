import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { MailTransportService } from './mail-transport.service';
import { NotificationRecipientsService } from './notification-recipients.service';
import { NotificationsConsumer } from './notifications.consumer';
import { renderMail } from './mail-layout';

interface DueBooking {
  bookingState: string;
  ticketState: string;
  assetCode: string | null;
  dueAt: Date;
  borrowerSub: string;
  borrowerName: string | null;
  borrowerEmail: string | null;
}

const appBase = () => process.env.APP_BASE_URL ?? 'http://localhost:8080';
const vnTime = (d: Date) =>
  d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

/**
 * Mail "tới hạn trả" — 1 mail đúng lúc buổi mượn hết hạn (Admin + người mượn). Consumer đọc
 * lại DB theo bookingId (payload chỉ ref): buổi đã trả/hủy hoặc ticket đã close trong khe relay
 * thì bỏ qua (không mail lỗi thời). Nhịp quá hạn (5.3) là handler riêng.
 */
@Injectable()
export class DueReminderMailRegistrar implements OnModuleInit {
  private readonly logger = new Logger(DueReminderMailRegistrar.name);

  constructor(
    private readonly consumer: NotificationsConsumer,
    private readonly recipients: NotificationRecipientsService,
    @Inject(DRIZZLE_DB) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.consumer.register('due_reminder', (ctx) =>
      this.sendDue(ctx.payload, ctx.mail),
    );
  }

  private async sendDue(
    payload: Record<string, unknown>,
    mail: MailTransportService,
  ): Promise<void> {
    const bookingId =
      typeof payload.bookingId === 'string' ? payload.bookingId : '';
    if (!bookingId) return;
    const b = await this.loadDueBooking(bookingId);
    // Đã trả/hủy buổi hoặc ticket không còn đang mượn → thôi (tránh mail lỗi thời).
    if (!b || b.bookingState !== 'delivered' || b.ticketState !== 'in_use')
      return;

    const to = Array.from(
      new Set([
        ...(await this.recipients.adminEmails()),
        ...(b.borrowerEmail ? [b.borrowerEmail] : []),
      ]),
    );
    if (to.length === 0) {
      this.logger.warn('không có người nhận mail tới hạn — bỏ qua');
      return;
    }
    const who = b.borrowerName ?? b.borrowerSub;
    const { html, text } = renderMail({
      title: 'Đến hạn trả tài sản',
      tone: 'warn',
      preheader: `Máy ${b.assetCode ?? '?'} đã đến hạn trả`,
      intro: `Máy ${b.assetCode ?? '?'} (người mượn ${who}) đã đến hạn trả.`,
      details: [
        { label: 'Máy', value: b.assetCode ?? '?' },
        { label: 'Hạn trả', value: vnTime(b.dueAt) },
        { label: 'Người mượn', value: who },
      ],
      cta: { label: 'Xem chi tiết', url: `${appBase()}/` },
    });
    await mail.send({
      to,
      subject: `QLTS: Đến hạn trả máy ${b.assetCode ?? ''}`.trim(),
      text,
      html,
    });
  }

  private async loadDueBooking(id: string): Promise<DueBooking | null> {
    const r = await this.db.execute<{
      booking_state: string;
      ticket_state: string;
      asset_code: string | null;
      due_at: Date;
      borrower_sub: string;
      full_name: string | null;
      email: string | null;
    }>(sql`
      SELECT b.state AS booking_state, t.state AS ticket_state,
        a.code AS asset_code, upper(b.period) AS due_at,
        t.borrower_sub, u.full_name, u.email
      FROM booking b
      JOIN ticket t ON t.id = b.ticket_id
      LEFT JOIN assets a ON a.id = b.asset_id
      LEFT JOIN users u ON u.sub = t.borrower_sub
      WHERE b.id = ${id}
    `);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      bookingState: row.booking_state,
      ticketState: row.ticket_state,
      assetCode: row.asset_code,
      dueAt: new Date(row.due_at),
      borrowerSub: row.borrower_sub,
      borrowerName: row.full_name,
      borrowerEmail: row.email && row.email !== '' ? row.email : null,
    };
  }
}
