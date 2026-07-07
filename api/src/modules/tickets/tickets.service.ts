import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { mapBookingPgError } from '../../common/booking-errors';
import { parseBookingWindow } from '../../common/booking-window';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { SystemConfigService } from '../config/system-config.service';
import { ACTIVE_TICKET_STATES, MAX_DURATION_AUTO_MS } from './ticket-states';

export interface SubmitBookingInput {
  assetId: string;
  from: string;
  to: string;
}

export interface SubmitBookingResult {
  ticketId: string;
  bookingId: string;
  ticketState: string;
  bookingState: string;
  autoApproved: boolean;
}

@Injectable()
export class TicketsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly config: SystemConfigService,
    private readonly audit: AuditWriterService,
  ) {}

  /**
   * Member tự đặt máy (FR-8, AD-4). ≤48h → tự duyệt (awaiting_pickup/pending);
   * >48h cần quyền dài hạn → giữ chỗ (pending_approval/held, hàng đợi Admin 3.4).
   * Quota + quyền dài hạn kiểm trong CÙNG transaction sau SELECT … FOR UPDATE hàng user
   * — đóng cả race quota lẫn TOCTOU thu quyền (review 3.1c). Đúng-sai chồng giờ/bookability
   * do DB ép (AD-2/AD-15) — mapBookingPgError dịch 409.
   */
  async submitOwnBooking(
    input: SubmitBookingInput,
    borrowerSub: string,
  ): Promise<SubmitBookingResult> {
    const windowDays = await this.config.getBookingWindowDays();
    const { from, to } = parseBookingWindow(input.from, input.to, windowDays);
    const isLongTerm = to.getTime() - from.getTime() > MAX_DURATION_AUTO_MS;
    const quota = await this.config.getActiveTicketQuota();

    const ticketState = isLongTerm ? 'pending_approval' : 'awaiting_pickup';
    const bookingState = isLongTerm ? 'held' : 'pending';

    try {
      return await this.db.transaction(async (tx) => {
        // Khóa hàng user → 2 submit đồng thời serialize tại đây (không constraint cứng,
        // vì 3.7 tạo hộ bỏ quota — AD-4). Đọc luôn can_long_term trong hàng đã khóa
        // → quyết long-term không có khe TOCTOU (admin thu quyền giữa check và insert).
        const locked = await tx.execute<{ can_long_term: boolean }>(sql`
          SELECT can_long_term FROM users WHERE sub = ${borrowerSub} FOR UPDATE
        `);
        if (locked.rows.length === 0) {
          throw new NotFoundException({
            code: 'USER_NOT_FOUND',
            message: 'Không tìm thấy tài khoản người mượn.',
          });
        }
        if (isLongTerm && !locked.rows[0].can_long_term) {
          throw new ForbiddenException({
            code: 'LONG_TERM_REQUIRED',
            message:
              'Không thể mượn hơn 2 ngày, vui lòng liên hệ Admin để được cấp quyền.',
          });
        }
        const active = await tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM ticket
          WHERE borrower_sub = ${borrowerSub}
            AND state IN (${sql.join(
              ACTIVE_TICKET_STATES.map((s) => sql`${s}`),
              sql`, `,
            )})
        `);
        if ((active.rows[0]?.n ?? 0) >= quota) {
          // 409 (Conflict) theo convention lỗi — nhất quán SLOT_TAKEN/ASSET_UNAVAILABLE
          throw new ConflictException({
            code: 'QUOTA_EXCEEDED',
            message: `Bạn đã đạt tối đa ${quota} lượt mượn đang hoạt động.`,
          });
        }

        const ticketRows = await tx.execute<{ id: string }>(sql`
          INSERT INTO ticket (kind, state, borrower_sub, created_by_sub)
          VALUES ('normal', ${ticketState}, ${borrowerSub}, ${borrowerSub})
          RETURNING id
        `);
        const ticketId = ticketRows.rows[0].id;

        const bookingRows = await tx.execute<{ id: string }>(sql`
          INSERT INTO booking (ticket_id, asset_id, kind, state, period)
          VALUES (${ticketId}, ${input.assetId}, 'normal', ${bookingState},
                  tstzrange(${input.from}, ${input.to}, '[)'))
          RETURNING id
        `);
        const bookingId = bookingRows.rows[0].id;

        await this.audit.appendWithin(tx, {
          actor: borrowerSub,
          action: 'tickets.create',
          objectType: 'ticket',
          objectId: ticketId,
          detail: {
            assetId: input.assetId,
            from: input.from,
            to: input.to,
            kind: 'normal',
            longTerm: isLongTerm,
          },
        });
        // Bước DUYỆT của ≤48h là tự động → actor='system' (FR-43, AD-10)
        if (!isLongTerm) {
          await this.audit.appendWithin(tx, {
            actor: 'system',
            action: 'tickets.auto_approve',
            objectType: 'ticket',
            objectId: ticketId,
            detail: { bookingId },
          });
        }

        return {
          ticketId,
          bookingId,
          ticketState,
          bookingState,
          autoApproved: !isLongTerm,
        };
      });
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }
}
