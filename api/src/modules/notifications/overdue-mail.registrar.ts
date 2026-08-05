import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { MailTransportService } from './mail-transport.service';
import { NotificationRecipientsService } from './notification-recipients.service';
import { NotificationsConsumer } from './notifications.consumer';
import { renderMail } from './mail-layout';

interface OverdueTicket {
  state: string;
  isOverdue: boolean;
  borrowerSub: string;
  borrowerName: string | null;
  borrowerEmail: string | null;
}

interface OverdueSession {
  assetCode: string | null;
  dueAt: Date;
}

interface PickupBooking {
  bookingState: string;
  assetCode: string | null;
}

const appBase = () => process.env.APP_BASE_URL ?? 'http://localhost:8080';
const vnTime = (d: Date) =>
  d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

/**
 * Luật mail quá hạn + nhắc giao (5.3, AD-11). Gắn 2 handler: `overdue_reminder` (1 mail/ngày
 * đến Admin + người mượn, nêu ĐÚNG buổi quá hạn — FR-25/48) và `pickup_reminder` (nhắc Admin
 * chưa bấm "đã giao" — FR-26). Consumer đọc lại DB theo id (payload chỉ ref).
 */
@Injectable()
export class OverdueMailRegistrar implements OnModuleInit {
  private readonly logger = new Logger(OverdueMailRegistrar.name);

  constructor(
    private readonly consumer: NotificationsConsumer,
    private readonly recipients: NotificationRecipientsService,
    @Inject(DRIZZLE_DB) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.consumer.register('overdue_reminder', (ctx) =>
      this.sendOverdue(ctx.payload, ctx.mail),
    );
    this.consumer.register('pickup_reminder', (ctx) =>
      this.sendPickup(ctx.payload, ctx.mail),
    );
  }

  private async sendOverdue(
    payload: Record<string, unknown>,
    mail: MailTransportService,
  ): Promise<void> {
    const ticketId =
      typeof payload.ticketId === 'string' ? payload.ticketId : '';
    if (!ticketId) return;
    const t = await this.loadOverdueTicket(ticketId);
    // Đã close / gỡ cờ trong khe relay → không mail lỗi thời (AC1).
    if (!t || t.state !== 'in_use' || !t.isOverdue) return;
    const sessions = await this.loadOverdueSessions(ticketId);
    if (sessions.length === 0) return; // hết buổi quá hạn (vừa trả) → thôi

    const to = Array.from(
      new Set([
        ...(await this.recipients.adminEmails()),
        ...(t.borrowerEmail ? [t.borrowerEmail] : []),
      ]),
    );
    if (to.length === 0) {
      this.logger.warn('không có người nhận mail quá hạn — bỏ qua');
      return;
    }
    const who = t.borrowerName ?? t.borrowerSub;
    const list = sessions.map(
      (s) => `Máy ${s.assetCode ?? '?'}: hạn trả ${vnTime(s.dueAt)}`,
    );
    const { html, text } = renderMail({
      title: 'Nhắc quá hạn trả tài sản',
      tone: 'danger',
      preheader: `Người mượn ${who} đang quá hạn`,
      intro: `Người mượn ${who} đang quá hạn các buổi sử dụng sau:`,
      list,
      cta: { label: 'Xem chi tiết', url: `${appBase()}/` },
    });
    await mail.send({
      to,
      subject: 'QLTS: Nhắc quá hạn — có tài sản chưa trả',
      text,
      html,
    });
  }

  private async sendPickup(
    payload: Record<string, unknown>,
    mail: MailTransportService,
  ): Promise<void> {
    const bookingId =
      typeof payload.bookingId === 'string' ? payload.bookingId : '';
    if (!bookingId) return;
    const b = await this.loadPickupBooking(bookingId);
    // Đã giao (delivered) / hủy trong khe relay → không nhắc lỗi thời (AC3).
    if (!b || (b.bookingState !== 'held' && b.bookingState !== 'pending'))
      return;
    const to = await this.recipients.adminEmails();
    if (to.length === 0) {
      this.logger.warn('không có admin email — bỏ qua nhắc giao');
      return;
    }
    const { html, text } = renderMail({
      title: 'Nhắc xác nhận giao máy',
      tone: 'warn',
      intro: `Đã đến giờ nhận máy ${b.assetCode ?? '?'} nhưng chưa bấm "đã giao".`,
      details: [{ label: 'Máy', value: b.assetCode ?? '?' }],
      cta: { label: 'Xử lý mượn', url: `${appBase()}/approvals` },
    });
    await mail.send({
      to,
      subject: 'QLTS: Nhắc xác nhận giao máy',
      text,
      html,
    });
  }

  private async loadOverdueTicket(id: string): Promise<OverdueTicket | null> {
    const r = await this.db.execute<{
      state: string;
      is_overdue: boolean;
      borrower_sub: string;
      full_name: string | null;
      email: string | null;
    }>(sql`
      SELECT t.state, t.is_overdue, t.borrower_sub, u.full_name, u.email
      FROM ticket t LEFT JOIN users u ON u.sub = t.borrower_sub
      WHERE t.id = ${id}
    `);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      state: row.state,
      isOverdue: row.is_overdue,
      borrowerSub: row.borrower_sub,
      borrowerName: row.full_name,
      borrowerEmail: row.email && row.email !== '' ? row.email : null,
    };
  }

  private async loadOverdueSessions(id: string): Promise<OverdueSession[]> {
    const r = await this.db.execute<{
      asset_code: string | null;
      due_at: Date;
    }>(sql`
      SELECT a.code AS asset_code, upper(b.period) AS due_at
      FROM booking b LEFT JOIN assets a ON a.id = b.asset_id
      WHERE b.ticket_id = ${id} AND b.state = 'delivered' AND upper(b.period) < now()
      ORDER BY upper(b.period)
    `);
    return r.rows.map((row) => ({
      assetCode: row.asset_code,
      dueAt: new Date(row.due_at),
    }));
  }

  private async loadPickupBooking(id: string): Promise<PickupBooking | null> {
    const r = await this.db.execute<{
      state: string;
      asset_code: string | null;
    }>(sql`
      SELECT b.state, a.code AS asset_code
      FROM booking b LEFT JOIN assets a ON a.id = b.asset_id
      WHERE b.id = ${id}
    `);
    if (r.rows.length === 0) return null;
    return { bookingState: r.rows[0].state, assetCode: r.rows[0].asset_code };
  }
}
