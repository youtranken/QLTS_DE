import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { MailTransportService } from './mail-transport.service';
import { NotificationRecipientsService } from './notification-recipients.service';
import { NotificationsConsumer } from './notifications.consumer';

interface OffboardUser {
  fullName: string | null;
  status: string;
  ticketCount: number;
  assetCount: number;
}

const appBase = () => process.env.APP_BASE_URL ?? 'http://localhost:8080';
const statusLabel = (s: string) =>
  s === 'deleted' ? 'đã bị xóa' : s === 'locked' ? 'đã bị khóa' : s;

/**
 * Mail cảnh báo nghỉ việc (5.5, FR-28, AD-11). Handler `offboard_alert` (payload `{sub}` từ scan
 * offboarding): mail nhóm Admin — user nào, còn bao nhiêu ticket/tài sản, link hàng đợi thu hồi.
 */
@Injectable()
export class OffboardMailRegistrar implements OnModuleInit {
  private readonly logger = new Logger(OffboardMailRegistrar.name);

  constructor(
    private readonly consumer: NotificationsConsumer,
    private readonly recipients: NotificationRecipientsService,
    @Inject(DRIZZLE_DB) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.consumer.register('offboard_alert', (ctx) =>
      this.send(ctx.payload, ctx.mail),
    );
  }

  private async send(
    payload: Record<string, unknown>,
    mail: MailTransportService,
  ): Promise<void> {
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub) return;
    const u = await this.load(sub);
    if (!u) return;
    // Mở khóa về active giữa enqueue-xử lý → cảnh báo tự tắt, không mail lỗi thời (m2).
    if (u.status !== 'locked' && u.status !== 'deleted') return;
    // M1: guard "còn tài sản/ticket" đặt lúc enqueue có thể lỗi thời — Admin thu hồi xong
    // trong khe enqueue→xử lý (user vẫn locked). Re-check live để không gửi mail "0 ticket 0 tài sản".
    if (u.ticketCount === 0 && u.assetCount === 0) return;
    const to = await this.recipients.adminEmails();
    if (to.length === 0) {
      this.logger.warn('không có admin email — bỏ qua cảnh báo nghỉ việc');
      return;
    }
    const who = u.fullName ?? sub;
    await mail.send({
      to,
      subject: 'QLTS: Cảnh báo nghỉ việc — tài khoản còn tài sản/ticket',
      text:
        `Tài khoản ${who} ${statusLabel(u.status)} nhưng còn ${u.ticketCount} ticket đang hoạt động ` +
        `và đứng tên ${u.assetCount} tài sản.\nVui lòng thu hồi/đổi người: ${appBase()}/canh-bao-nghi-viec`,
    });
  }

  private async load(sub: string): Promise<OffboardUser | null> {
    const r = await this.db.execute<{
      full_name: string | null;
      status: string;
      ticket_count: number;
      asset_count: number;
    }>(sql`
      SELECT u.full_name, u.status,
        (SELECT count(*)::int FROM ticket t
         WHERE t.borrower_sub = u.sub AND t.state = 'in_use') AS ticket_count,
        (SELECT count(*)::int FROM assets a WHERE a.assigned_user_sub = u.sub) AS asset_count
      FROM users u WHERE u.sub = ${sub}
    `);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      fullName: row.full_name,
      status: row.status,
      ticketCount: row.ticket_count,
      assetCount: row.asset_count,
    };
  }
}
