import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { MailTransportService } from './mail-transport.service';
import { NotificationRecipientsService } from './notification-recipients.service';
import { NotificationsConsumer } from './notifications.consumer';
import { renderMail, vnDateTime } from './mail-layout';

interface ExtInfo {
  borrowerEmail: string | null;
  fullName: string | null;
  assetCode: string | null;
  oldDue: Date | null;
  reqDue: Date | null;
}

const appBase = () => process.env.APP_BASE_URL ?? 'http://localhost:8080';

/**
 * Mail luồng gia hạn (đảo FR-47 theo yêu cầu vận hành): 2 chiều —
 * `extension_requested` (member xin → nhóm Admin) và `extension_rejected` (Admin từ chối → người
 * mượn, kèm lý do). Duyệt gia hạn KHÔNG mail (user tự thấy hạn mới trên app). Consumer đã chốt
 * bật/tắt theo cấu hình thông báo trước khi gọi handler.
 */
@Injectable()
export class ExtensionMailRegistrar implements OnModuleInit {
  private readonly logger = new Logger(ExtensionMailRegistrar.name);

  constructor(
    private readonly consumer: NotificationsConsumer,
    private readonly recipients: NotificationRecipientsService,
    @Inject(DRIZZLE_DB) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.consumer.register('extension_requested', (ctx) =>
      this.sendRequested(ctx.payload, ctx.mail),
    );
    this.consumer.register('extension_rejected', (ctx) =>
      this.sendRejected(ctx.payload, ctx.mail),
    );
  }

  private async load(ticketId: string): Promise<ExtInfo | null> {
    const r = await this.db.execute<{
      email: string | null;
      full_name: string | null;
      asset_code: string | null;
      old_due: Date | null;
      req_due: Date | null;
    }>(sql`
      SELECT u.email, u.full_name,
        (SELECT a.code FROM booking b JOIN assets a ON a.id = b.asset_id
           WHERE b.ticket_id = t.id AND b.kind = 'normal' AND b.state = 'delivered' LIMIT 1) AS asset_code,
        (SELECT upper(b.period) FROM booking b
           WHERE b.ticket_id = t.id AND b.kind = 'normal' AND b.state = 'delivered' LIMIT 1) AS old_due,
        (SELECT upper(b.period) FROM booking b
           WHERE b.ticket_id = t.id AND b.kind = 'extension' ORDER BY upper(b.period) DESC LIMIT 1) AS req_due
      FROM ticket t LEFT JOIN users u ON u.sub = t.borrower_sub
      WHERE t.id = ${ticketId}
    `);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      borrowerEmail: row.email && row.email !== '' ? row.email : null,
      fullName: row.full_name,
      assetCode: row.asset_code,
      oldDue: row.old_due ? new Date(row.old_due) : null,
      reqDue: row.req_due ? new Date(row.req_due) : null,
    };
  }

  private async sendRequested(
    payload: Record<string, unknown>,
    mail: MailTransportService,
  ): Promise<void> {
    const ticketId =
      typeof payload.ticketId === 'string' ? payload.ticketId : '';
    if (!ticketId) return;
    const e = await this.load(ticketId);
    if (!e) return;
    const to = await this.recipients.adminEmails();
    if (to.length === 0) {
      this.logger.warn('không có admin email — bỏ qua mail xin gia hạn');
      return;
    }
    const who = e.fullName ?? 'Người mượn';
    const { html, text } = renderMail({
      title: 'Yêu cầu gia hạn cần duyệt',
      tone: 'info',
      preheader: `${who} xin gia hạn máy ${e.assetCode ?? '?'}`,
      intro: `${who} vừa gửi yêu cầu gia hạn, đang chờ bạn duyệt.`,
      details: [
        { label: 'MTS (mã máy)', value: e.assetCode ?? '?' },
        { label: 'Hạn trả hiện tại', value: e.oldDue ? vnDateTime(e.oldDue) : '?' },
        { label: 'Xin gia hạn tới', value: e.reqDue ? vnDateTime(e.reqDue) : '?' },
      ],
      cta: { label: 'Xem và duyệt', url: `${appBase()}/approvals` },
    });
    await mail.send({ to, subject: 'QLTS: Có yêu cầu gia hạn cần duyệt', text, html });
  }

  private async sendRejected(
    payload: Record<string, unknown>,
    mail: MailTransportService,
  ): Promise<void> {
    const ticketId =
      typeof payload.ticketId === 'string' ? payload.ticketId : '';
    const reason = typeof payload.reason === 'string' ? payload.reason : '';
    if (!ticketId) return;
    const e = await this.load(ticketId);
    if (!e) return;
    if (!e.borrowerEmail) {
      this.logger.warn('người mượn không có email — bỏ qua mail từ chối gia hạn');
      return;
    }
    const { html, text } = renderMail({
      title: 'Yêu cầu gia hạn bị từ chối',
      tone: 'warn',
      intro: [
        `Yêu cầu gia hạn của bạn đã bị quản trị viên từ chối.`,
        'Vui lòng trả máy đúng hạn hoặc liên hệ quản trị viên.',
      ],
      details: [
        { label: 'MTS (mã máy)', value: e.assetCode ?? '?' },
        { label: 'Hạn trả hiện tại', value: e.oldDue ? vnDateTime(e.oldDue) : '?' },
        { label: 'Đã xin gia hạn tới', value: e.reqDue ? vnDateTime(e.reqDue) : '?' },
        { label: 'Lý do từ chối', value: reason || '(không nêu)' },
      ],
      cta: { label: 'Xem yêu cầu của tôi', url: `${appBase()}/` },
    });
    await mail.send({
      to: [e.borrowerEmail],
      subject: 'QLTS: Yêu cầu gia hạn của bạn đã bị từ chối',
      text,
      html,
    });
  }
}
