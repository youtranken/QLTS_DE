import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { MailTransportService } from './mail-transport.service';
import { NotificationsConsumer } from './notifications.consumer';
import { renderMail, vnDateTime } from './mail-layout';

interface CancelledBooking {
  assetCode: string | null;
  assetStatus: string;
  assetIsPool: boolean;
  from: Date;
  to: Date;
  borrowerEmail: string | null;
}

/** Lý do hủy derive từ trạng thái asset hiện tại (cascade đã đổi asset cùng tx trước khi hủy). */
function reasonText(status: string, isPool: boolean): string {
  if (status === 'disposed') return 'máy đã được thanh lý';
  if (status === 'locked_repair') return 'máy đang được khóa để sửa chữa';
  if (!isPool) return 'máy đã bị gỡ khỏi nhóm cho mượn';
  return 'máy hiện không khả dụng';
}

/**
 * Mail báo booking bị hủy do máy khóa/gỡ pool/thanh lý (5.4, FR-27, AD-11). Handler cho topic
 * `booking_cancelled` (đã phát per-booking từ cascade 3.10/3.13). Mỗi booking = 1 mail đến
 * NGƯỜI MƯỢN — không gộp (party phiên 6).
 */
@Injectable()
export class CascadeCancelMailRegistrar implements OnModuleInit {
  private readonly logger = new Logger(CascadeCancelMailRegistrar.name);

  constructor(
    private readonly consumer: NotificationsConsumer,
    @Inject(DRIZZLE_DB) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.consumer.register('booking_cancelled', (ctx) =>
      this.send(ctx.payload, ctx.mail),
    );
  }

  private async send(
    payload: Record<string, unknown>,
    mail: MailTransportService,
  ): Promise<void> {
    const bookingId =
      typeof payload.bookingId === 'string' ? payload.bookingId : '';
    if (!bookingId) return;
    const b = await this.load(bookingId);
    if (!b) return;
    if (!b.borrowerEmail) {
      this.logger.warn('người mượn không có email — bỏ qua mail hủy booking');
      return;
    }
    const reason = reasonText(b.assetStatus, b.assetIsPool);
    const { html, text } = renderMail({
      title: 'Lượt mượn đã bị hủy',
      tone: 'danger',
      intro: [
        `Lượt mượn của bạn đã bị hủy vì ${reason}.`,
        'Vui lòng đặt lại máy khác nếu cần.',
      ],
      details: [
        { label: 'MTS (mã máy)', value: b.assetCode ?? '?' },
        { label: 'Ngày nhận', value: vnDateTime(b.from) },
        { label: 'Ngày trả', value: vnDateTime(b.to) },
        { label: 'Lý do', value: reason },
      ],
    });
    await mail.send({
      to: [b.borrowerEmail],
      subject: 'QLTS: Lượt mượn của bạn đã bị hủy',
      text,
      html,
    });
  }

  private async load(bookingId: string): Promise<CancelledBooking | null> {
    const r = await this.db.execute<{
      asset_code: string | null;
      asset_status: string;
      asset_is_pool: boolean;
      from_at: Date;
      to_at: Date;
      email: string | null;
    }>(sql`
      SELECT a.code AS asset_code, a.status AS asset_status, a.is_pool AS asset_is_pool,
             lower(b.period) AS from_at, upper(b.period) AS to_at,
             u.email
      FROM booking b
      JOIN assets a ON a.id = b.asset_id
      JOIN ticket t ON t.id = b.ticket_id
      LEFT JOIN users u ON u.sub = t.borrower_sub
      WHERE b.id = ${bookingId}
    `);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      assetCode: row.asset_code,
      assetStatus: row.asset_status,
      assetIsPool: row.asset_is_pool,
      from: new Date(row.from_at),
      to: new Date(row.to_at),
      borrowerEmail: row.email && row.email !== '' ? row.email : null,
    };
  }
}
