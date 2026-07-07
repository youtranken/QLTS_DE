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
import {
  ACTIVE_TICKET_STATES,
  MAX_DURATION_AUTO_MS,
  OCCUPYING_STATES,
  TICKET_STATE_LABELS_VI,
} from './ticket-states';
import type { TicketState } from './ticket-states';

export interface SubmitBookingInput {
  assetId: string;
  from: string;
  to: string;
}

export interface MyTicket {
  id: string;
  state: string;
  stateLabel: string;
  kind: string;
  version: number;
  assetCode: string | null;
  from: string | null;
  to: string | null;
  createdAt: string;
  cancellable: boolean;
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

  /**
   * "Request của tôi" (FR-11, NFR-7) — CHỈ ticket của member đó (WHERE borrower_sub).
   * Kèm nhãn tiếng Việt (AD-16) + máy + khung giờ + cờ hủy được (FE ẩn/hiện nút).
   */
  async listMyTickets(borrowerSub: string): Promise<MyTicket[]> {
    const rows = await this.db.execute<{
      id: string;
      state: string;
      kind: string;
      version: number;
      created_at: string;
      asset_code: string | null;
      from_ts: string | null;
      to_ts: string | null;
      pickup_ts: string | null;
    }>(sql`
      SELECT t.id, t.state, t.kind, t.version, t.created_at,
        a.code AS asset_code,
        lower(b.period) AS from_ts, upper(b.period) AS to_ts,
        -- giờ nhận sớm nhất tính TRÊN booking còn chiếm chỗ (bỏ cancelled/returned cũ —
        -- chống false-negative khi Epic 4 thêm nhiều booking/ticket)
        (SELECT min(lower(b2.period)) FROM booking b2
           WHERE b2.ticket_id = t.id
             AND b2.state IN (${sql.join(
               OCCUPYING_STATES.map((s) => sql`${s}`),
               sql`, `,
             )})) AS pickup_ts
      FROM ticket t
      LEFT JOIN booking b ON b.ticket_id = t.id
      LEFT JOIN assets a ON a.id = b.asset_id
      WHERE t.borrower_sub = ${borrowerSub}
      ORDER BY t.created_at DESC, b.id
    `);
    const now = Date.now();
    return rows.rows.map((r) => ({
      id: r.id,
      state: r.state,
      stateLabel: TICKET_STATE_LABELS_VI[r.state as TicketState] ?? r.state,
      kind: r.kind,
      version: r.version,
      assetCode: r.asset_code,
      from: r.from_ts ? new Date(r.from_ts).toISOString() : null,
      to: r.to_ts ? new Date(r.to_ts).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
      cancellable: this.isCancellable(
        r.state,
        r.pickup_ts ? new Date(r.pickup_ts).getTime() : null,
        now,
      ),
    }));
  }

  /** Hủy được: pending_approval bất kỳ lúc nào; awaiting_pickup CHỈ trước giờ nhận (FR-11). */
  private isCancellable(
    state: string,
    pickupMs: number | null,
    now: number,
  ): boolean {
    if (state === 'pending_approval') return true;
    if (state === 'awaiting_pickup') return pickupMs === null || now < pickupMs;
    return false;
  }

  /**
   * Member tự hủy ticket của mình (FR-11). IDOR: borrower≠sub → 403. Optimistic
   * lock: version lệch → 409 STALE_VERSION (Admin thao tác cùng ticket, FR-49).
   * Hủy → ticket+booking cancelled, khung nhả (rời OCCUPYING), quota giải phóng.
   */
  async cancelMyTicket(
    ticketId: string,
    borrowerSub: string,
    version: number,
  ): Promise<{ id: string; state: string }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute<{
        borrower_sub: string;
        state: string;
        version: number;
        pickup_ts: string | null;
      }>(sql`
        SELECT t.borrower_sub, t.state, t.version,
          (SELECT min(lower(b.period)) FROM booking b
             WHERE b.ticket_id = t.id
               AND b.state IN (${sql.join(
                 OCCUPYING_STATES.map((s) => sql`${s}`),
                 sql`, `,
               )})) AS pickup_ts
        FROM ticket t WHERE t.id = ${ticketId} FOR UPDATE
      `);
      if (rows.rows.length === 0) {
        throw new NotFoundException({
          code: 'TICKET_NOT_FOUND',
          message: 'Không tìm thấy request này.',
        });
      }
      const t = rows.rows[0];
      // IDOR: ticket người khác → 403 (dù tồn tại) — không lộ thông tin
      if (t.borrower_sub !== borrowerSub) {
        throw new ForbiddenException({
          code: 'NOT_TICKET_OWNER',
          message: 'Bạn không có quyền với request này.',
        });
      }
      if (t.version !== version) {
        throw new ConflictException({
          code: 'STALE_VERSION',
          message: 'Request vừa được cập nhật — vui lòng tải lại.',
        });
      }
      const pickupMs = t.pickup_ts ? new Date(t.pickup_ts).getTime() : null;
      if (!this.isCancellable(t.state, pickupMs, Date.now())) {
        throw new ConflictException({
          code: 'CANNOT_CANCEL',
          message:
            'Không thể hủy request ở trạng thái này (đã qua giờ nhận hoặc đã kết thúc).',
        });
      }

      await tx.execute(sql`
        UPDATE ticket SET state = 'cancelled', version = version + 1, updated_at = now()
        WHERE id = ${ticketId}
      `);
      // Hủy MỌI booking occupying của ticket (nhả khung) — cancelled/returned giữ nguyên
      await tx.execute(sql`
        UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
        WHERE ticket_id = ${ticketId}
          AND state IN (${sql.join(
            OCCUPYING_STATES.map((s) => sql`${s}`),
            sql`, `,
          )})
      `);
      await this.audit.appendWithin(tx, {
        actor: borrowerSub,
        action: 'tickets.cancel',
        objectType: 'ticket',
        objectId: ticketId,
        detail: { by: 'member', fromState: t.state },
      });
      return { id: ticketId, state: 'cancelled' };
    });
  }
}
