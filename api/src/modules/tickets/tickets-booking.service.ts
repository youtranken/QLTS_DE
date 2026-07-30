import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { mapBookingPgError } from '../../common/booking-errors';
import {
  assertBookingDuration,
  parseBookingWindow,
} from '../../common/booking-window';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { SystemConfigService } from '../config/system-config.service';
import { OutboxService } from '../outbox/outbox.service';
import { TicketsApprovalService } from './tickets-approval.service';
import { TicketsHandoverService } from './tickets-handover.service';
import {
  ACTIVE_TICKET_STATES,
  OCCUPYING_STATES,
  isTicketCancellable,
} from './ticket-states';
import type { SubmitBookingInput, SubmitBookingResult } from './tickets.service';

/**
 * Write-path đặt/hủy mượn (AD-4): submitOwnBooking (member ≤48h tự-duyệt / >48h giữ chỗ),
 * createForMember (Admin tạo hộ bỏ quota), cancelMyTicket, adminForceCancel + helper
 * expireStaleHoldsForAsset (expire-on-conflict). TOCTOU/quota/bookability do DB ép.
 * Tách khỏi TicketsService (mục 6); gọi approval.cancelExpiredWithin + handover.attach…
 */
@Injectable()
export class TicketsBookingService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly config: SystemConfigService,
    private readonly audit: AuditWriterService,
    private readonly outbox: OutboxService,
    private readonly approval: TicketsApprovalService,
    private readonly handover: TicketsHandoverService,
  ) {}

  async submitOwnBooking(
    input: SubmitBookingInput,
    borrowerSub: string,
  ): Promise<SubmitBookingResult> {
    const windowDays = await this.config.getBookingWindowDays();
    const maxDurationHours = await this.config.getMaxBookingDurationHours();
    const { from, to } = parseBookingWindow(
      input.from,
      input.to,
      windowDays,
      Date.now(),
      maxDurationHours,
    );
    // Ngưỡng auto-duyệt lấy từ config (audit H2) để SA chỉnh; hằng số cũ chỉ còn là mặc định seed.
    const autoApproveMs =
      (await this.config.getAutoApproveMaxHours()) * 3_600_000;
    const isLongTerm = to.getTime() - from.getTime() > autoApproveMs;
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

        const note = input.note?.trim() ? input.note.trim() : null;

        // Expire-on-conflict (AD-9, 3.5b): giải phóng dòng held CŨ đã quá giờ nhận trên máy
        // này chồng khung — member không phải chờ sweep. Nếu vẫn còn booking hợp lệ chồng
        // → INSERT dưới đây 23P01 → SLOT_TAKEN thật.
        await this.expireStaleHoldsForAsset(
          tx,
          input.assetId,
          input.from,
          input.to,
        );

        const bookingRows = await tx.execute<{ id: string }>(sql`
          INSERT INTO booking (ticket_id, asset_id, kind, state, period, note)
          VALUES (${ticketId}, ${input.assetId}, 'normal', ${bookingState},
                  tstzrange(${input.from}, ${input.to}, '[)'), ${note})
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
        } else {
          // 5.2: request CẦN DUYỆT → mail nhóm Admin ngay (cùng tx, AD-11). Auto-approve
          // ≤48h KHÔNG phát → không mail.
          await this.outbox.enqueueWithin(tx, 'approval_requested', {
            ticketId,
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

  async createForMember(
    input: {
      borrowerSub: string;
      assetId: string;
      from: string;
      to: string;
      mode: 'now' | 'schedule';
      note: string | null;
      photoIds: string[];
    },
    actorSub: string,
  ): Promise<{ ticketId: string; ticketState: string }> {
    if (input.borrowerSub === actorSub) {
      throw new ForbiddenException({
        code: 'SELF_CREATE_FORBIDDEN',
        message: 'Admin không tạo hộ cho chính mình (không đi luồng mượn).',
      });
    }
    const to = new Date(input.to);
    const from = new Date(input.from);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: 'Giờ không hợp lệ.',
      });
    }
    const maxDurationHours = await this.config.getMaxBookingDurationHours();
    if (input.mode === 'schedule') {
      // đặt lịch tương lai: from≥now + trong window
      const windowDays = await this.config.getBookingWindowDays();
      parseBookingWindow(
        input.from,
        input.to,
        windowDays,
        Date.now(),
        maxDurationHours,
      );
    } else {
      // giao ngay = giao TẠI CHỖ: from ≤ now (không đặt lịch tương lai — dùng schedule),
      // to > now (máy đang giao thì hạn trả phải ở tương lai). Chống backdate/future-in_use
      // tạo trạng thái domain vô nghĩa (review Med1).
      const now = Date.now();
      if (to.getTime() <= from.getTime()) {
        throw new BadRequestException({
          code: 'INVALID_RANGE',
          message: 'Giờ trả phải sau giờ nhận.',
        });
      }
      if (from.getTime() > now) {
        throw new BadRequestException({
          code: 'INVALID_RANGE',
          message:
            'Giao ngay: giờ nhận không được ở tương lai — dùng "Đặt lịch".',
        });
      }
      if (to.getTime() <= now) {
        throw new BadRequestException({
          code: 'INVALID_RANGE',
          message: 'Giao ngay: hạn trả phải ở tương lai.',
        });
      }
      // Nhánh này KHÔNG đi qua parseBookingWindow → phải tự áp trần (audit H-2).
      assertBookingDuration(from, to, maxDurationHours);
    }

    const ticketState = input.mode === 'now' ? 'in_use' : 'awaiting_pickup';
    const bookingState = input.mode === 'now' ? 'delivered' : 'pending';

    try {
      return await this.db.transaction(async (tx) => {
        // borrower phải là member tồn tại — Admin/SA không đi luồng mượn (mục 3 PRD)
        const u = await tx.execute<{ role: string }>(sql`
          SELECT role FROM users WHERE sub = ${input.borrowerSub}
        `);
        if (u.rows.length === 0) {
          throw new NotFoundException({
            code: 'USER_NOT_FOUND',
            message: 'Không tìm thấy người mượn.',
          });
        }
        if (u.rows[0].role !== 'member') {
          throw new ForbiddenException({
            code: 'BORROWER_NOT_MEMBER',
            message: 'Chỉ tạo hộ cho member (Admin/SA không đi luồng mượn).',
          });
        }

        const ticketRows = await tx.execute<{ id: string }>(sql`
          INSERT INTO ticket (kind, state, borrower_sub, created_by_sub,
            delivered_at)
          VALUES ('normal', ${ticketState}, ${input.borrowerSub}, ${actorSub},
            ${input.mode === 'now' ? sql`now()` : sql`NULL`})
          RETURNING id
        `);
        const ticketId = ticketRows.rows[0].id;

        // Expire-on-conflict (nhất quán submitOwnBooking): nhả held cũ quá giờ chồng khung
        // → tránh SLOT_TAKEN giả trước khi sweep chạy (review Low1).
        await this.expireStaleHoldsForAsset(
          tx,
          input.assetId,
          input.from,
          input.to,
        );

        await tx.execute(sql`
          INSERT INTO booking (ticket_id, asset_id, kind, state, period)
          VALUES (${ticketId}, ${input.assetId}, 'normal', ${bookingState},
                  tstzrange(${input.from}, ${input.to}, '[)'))
        `);

        // giao ngay → gắn note/ảnh tình trạng đầu (reuse 3.6, kiểm file tồn tại)
        if (input.mode === 'now') {
          await this.handover.attachHandoverArtifacts(
            tx,
            ticketId,
            input.assetId,
            'deliver',
            input.note,
            input.photoIds,
            actorSub,
          );
        }

        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'tickets.create_for',
          objectType: 'ticket',
          objectId: ticketId,
          detail: {
            borrower: input.borrowerSub,
            mode: input.mode,
            assetId: input.assetId,
            from: input.from,
            to: input.to,
          },
        });
        return { ticketId, ticketState };
      });
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }

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
        kind: string;
        pickup_passed: boolean | null;
      }>(sql`
        SELECT t.borrower_sub, t.state, t.version, t.kind,
          (SELECT min(lower(b.period)) < now() FROM booking b
             WHERE b.ticket_id = t.id
               AND b.state IN (${sql.join(
                 OCCUPYING_STATES.map((s) => sql`${s}`),
                 sql`, `,
               )})) AS pickup_passed
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
      // Chuỗi định kỳ = 1 ticket cha nhiều buổi: hủy cả cụm ở đây sẽ ghi thẳng 'cancelled'
      // bỏ qua deriveParentState (buổi đã returned phải ra 'closed'). Member hủy từng buổi
      // qua chức năng chuỗi (4.6) — chặn như adminForceCancel để giữ bất biến cha (AD-4).
      if (t.kind !== 'normal') {
        throw new ConflictException({
          code: 'IS_RECURRING',
          message:
            'Chuỗi định kỳ phải hủy qua chức năng chuỗi (giữ bất biến trạng thái cha).',
        });
      }
      if (!isTicketCancellable(t.state, t.pickup_passed)) {
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

  async adminForceCancel(
    ticketId: string,
    actorSub: string,
    reason: string,
  ): Promise<{ id: string; state: string }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute<{ state: string; kind: string }>(
        sql`SELECT state, kind FROM ticket WHERE id = ${ticketId} FOR UPDATE`,
      );
      if (rows.rows.length === 0) {
        throw new NotFoundException({
          code: 'TICKET_NOT_FOUND',
          message: 'Không tìm thấy request này.',
        });
      }
      const t = rows.rows[0];
      if (t.kind !== 'normal') {
        throw new ConflictException({
          code: 'IS_RECURRING',
          message:
            'Chuỗi định kỳ phải hủy qua chức năng chuỗi (giữ bất biến trạng thái cha).',
        });
      }
      if (t.state === 'in_use') {
        throw new ConflictException({
          code: 'ALREADY_DELIVERED',
          message: 'Máy đã giao — dùng chức năng Trả để thu hồi, không hủy cưỡng chế.',
        });
      }
      if (t.state !== 'pending_approval' && t.state !== 'awaiting_pickup') {
        throw new ConflictException({
          code: 'CANNOT_CANCEL',
          message: 'Request đã kết thúc — không còn gì để hủy.',
        });
      }

      await tx.execute(sql`
        UPDATE ticket SET state = 'cancelled', version = version + 1, updated_at = now()
        WHERE id = ${ticketId}
      `);
      await tx.execute(sql`
        UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
        WHERE ticket_id = ${ticketId}
          AND state IN (${sql.join(
            OCCUPYING_STATES.map((s) => sql`${s}`),
            sql`, `,
          )})
      `);
      await this.audit.appendWithin(tx, {
        actor: actorSub,
        action: 'tickets.force_cancel',
        objectType: 'ticket',
        objectId: ticketId,
        detail: { by: 'admin', fromState: t.state, reason },
      });
      // Người bị hủy PHẢI được báo kèm lý do — hủy im lặng thì họ vẫn chờ máy.
      // Cùng tx với thay đổi trạng thái (AD-11 outbox transactional).
      await this.outbox.enqueueWithin(tx, 'ticket_force_cancelled', {
        ticketId,
        reason,
      });
      return { id: ticketId, state: 'cancelled' };
    });
  }

  private async expireStaleHoldsForAsset(
    tx: Pick<Database, 'execute' | 'insert'>,
    assetId: string,
    fromIso: string,
    toIso: string,
  ): Promise<void> {
    const stale = await tx.execute<{ ticket_id: string }>(sql`
      SELECT DISTINCT b.ticket_id FROM booking b
      WHERE b.asset_id = ${assetId}
        AND b.state = 'held'
        AND lower(b.period) < now()
        AND b.period && tstzrange(${fromIso}, ${toIso}, '[)')
    `);
    for (const row of stale.rows) {
      // Khóa TICKET trước (khớp thứ tự sweep) rồi re-check pending_approval
      const t = await tx.execute<{ state: string }>(sql`
        SELECT state FROM ticket WHERE id = ${row.ticket_id} FOR UPDATE
      `);
      if (t.rows[0]?.state === 'pending_approval') {
        await this.approval.cancelExpiredWithin(tx, row.ticket_id);
      }
    }
  }
}
