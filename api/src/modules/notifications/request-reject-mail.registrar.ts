import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { MailTransportService } from './mail-transport.service';
import { NotificationsConsumer } from './notifications.consumer';
import { renderMail, vnDateTime } from './mail-layout';

interface Rejected {
  assetCode: string | null;
  from: Date | null;
  to: Date | null;
  borrowerEmail: string | null;
}

const dt = (d: Date | null) => (d ? vnDateTime(d) : '?');

/**
 * Mail báo YÊU CẦU MƯỢN bị Admin TỪ CHỐI lúc chờ duyệt (topic `request_rejected`). Khác hủy
 * cưỡng chế (đã duyệt rồi mới hủy): đây là từ chối ngay ở bước duyệt. Lý do Admin gõ → chuyển
 * nguyên văn tới người mượn.
 */
@Injectable()
export class RequestRejectMailRegistrar implements OnModuleInit {
  private readonly logger = new Logger(RequestRejectMailRegistrar.name);

  constructor(
    private readonly consumer: NotificationsConsumer,
    @Inject(DRIZZLE_DB) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.consumer.register('request_rejected', (ctx) =>
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
      this.logger.warn('người mượn không có email — bỏ qua mail từ chối yêu cầu');
      return;
    }
    const { html, text } = renderMail({
      title: 'Yêu cầu mượn bị từ chối',
      tone: 'warn',
      intro: [
        'Yêu cầu mượn máy của bạn đã bị quản trị viên từ chối.',
        'Nếu vẫn cần máy, vui lòng đặt lại hoặc liên hệ quản trị viên.',
      ],
      details: [
        { label: 'MTS (mã máy)', value: t.assetCode ?? '?' },
        { label: 'Ngày nhận', value: dt(t.from) },
        { label: 'Ngày trả', value: dt(t.to) },
        { label: 'Lý do từ chối', value: reason || '(không nêu)' },
      ],
    });
    await mail.send({
      to: [t.borrowerEmail],
      subject: 'QLTS: Yêu cầu mượn của bạn đã bị từ chối',
      text,
      html,
    });
  }

  private async load(ticketId: string): Promise<Rejected | null> {
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
