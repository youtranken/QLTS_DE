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
import { ExtensionService } from './extension.service';
import { TicketsLifecycleService } from './tickets-lifecycle.service';
import { TicketsApprovalService } from './tickets-approval.service';
import { TicketsReadService } from './tickets-read.service';
import { TicketsSweepService } from './tickets-sweep.service';
import {
  ACTIVE_TICKET_STATES,
  OCCUPYING_STATES,
  isTicketCancellable,
} from './ticket-states';

export interface SubmitBookingInput {
  assetId: string;
  from: string;
  to: string;
  note?: string | null;
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
  isOverdue: boolean;
  overdueMinutes: number | null;
  extensionCount: number;
  hasPendingExtension: boolean;
  sessionCount: number;
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
    private readonly outbox: OutboxService,
    private readonly extension: ExtensionService,
    private readonly lifecycle: TicketsLifecycleService,
    private readonly read: TicketsReadService,
    private readonly sweep: TicketsSweepService,
    private readonly approval: TicketsApprovalService,
  ) {}

  // Vòng đời máy cascade (lock/unlock/dispose/setPool/preview) → TicketsLifecycleService.
  lockAssetCascade(
    assetId: string,
    reason: string,
    eta: string | null,
    version: number,
    actorSub: string,
    notify = true,
  ) {
    return this.lifecycle.lockAssetCascade(
      assetId,
      reason,
      eta,
      version,
      actorSub,
      notify,
    );
  }

  unlockAsset(assetId: string, version: number, actorSub: string) {
    return this.lifecycle.unlockAsset(assetId, version, actorSub);
  }

  disposeAssetCascade(
    assetId: string,
    version: number,
    actorSub: string,
    notify = true,
  ) {
    return this.lifecycle.disposeAssetCascade(assetId, version, actorSub, notify);
  }

  setPoolCascade(
    assetId: string,
    isPool: boolean,
    version: number,
    actorSub: string,
    notify = true,
  ) {
    return this.lifecycle.setPoolCascade(assetId, isPool, version, actorSub, notify);
  }

  previewLifecycleCascade(assetId: string) {
    return this.lifecycle.previewLifecycleCascade(assetId);
  }

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

  /**
   * Admin tạo request HỘ member (FR-12) — BỎ QUA quota + quyền per-user, VẪN EXCLUDE (AD-2)
   * + bookability (AD-15). Skip-quota chỉ hợp lệ khi actor (Admin) ≠ borrower (AD-4). Hai chế
   * độ: 'now' (giao ngay → in_use/delivered) | 'schedule' (đặt lịch → awaiting_pickup/pending).
   */
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
          await this.attachHandoverArtifacts(
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

  /**
   * "Request của tôi" (FR-11, NFR-7) — CHỈ ticket của member đó (WHERE borrower_sub).
   * Kèm nhãn tiếng Việt (AD-16) + máy + khung giờ + cờ hủy được (FE ẩn/hiện nút).
   */
  listMyTickets(borrowerSub: string) {
    return this.read.listMyTickets(borrowerSub);
  }

  /**
   * Chi tiết các buổi của một chuỗi định kỳ (4.5b) — CHỈ chủ chuỗi (IDOR: borrower≠sub → 403).
   * FE mở rộng dòng cha để xem từng buổi + trạng thái. Sort theo giờ tăng dần.
   */
  listMyRecurringSessions(ticketId: string, borrowerSub: string) {
    return this.read.listMyRecurringSessions(ticketId, borrowerSub);
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
        pickup_passed: boolean | null;
      }>(sql`
        SELECT t.borrower_sub, t.state, t.version,
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

  /**
   * Admin hủy CƯỠNG CHẾ ticket của người khác (audit H-2) — lối thoát vận hành.
   * Trước bản vá này KHÔNG có đường nào gỡ một ticket đã duyệt nhưng kẹt: member không
   * hủy được sau giờ nhận, autoCloseNoShow chỉ chạy khi hết period, sweep bỏ qua
   * 'pending' → máy giam tới khi can thiệp SQL tay.
   *
   * Khác `cancelMyTicket`: KHÔNG kiểm chủ sở hữu, KHÔNG kiểm pickup_passed, KHÔNG cần
   * version (admin quyết trên hiện trạng). Vẫn chặn trạng thái đã kết thúc và chuỗi
   * định kỳ (kind='recurring' có đường hủy riêng đi qua deriveParentState — AD-4).
   *
   * CHỈ cho pending_approval + awaiting_pickup (review M1): ticket 'in_use' là máy ĐÃ GIAO
   * thật, hủy sẽ nhả booking → poolFreeNow thấy máy free trong khi nó còn ở tay người mượn
   * (double-allocation, không vết thu hồi). Máy in_use phải đi đường Trả (returnTicket).
   */
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

  /**
   * Hàng đợi Admin "Chờ duyệt" (FR-13) — request >48h/định kỳ đang giữ chỗ (held).
   * Admin THẤY tên người mượn (hàng đợi nội bộ, khác read-model AD-5 công khai).
   */
  listPendingApproval() {
    return this.read.listPendingApproval();
  }

  /**
   * Hàng đợi Admin theo trạng thái (FR-45): chờ giao (awaiting_pickup) / đang mượn (in_use).
   * Kèm tên người mượn + máy + khung + version cho nút giao/nhận. Booking occupying của ticket.
   */
  listQueue(ticketState: 'awaiting_pickup' | 'in_use') {
    return this.read.listQueue(ticketState);
  }

  /**
   * "Máy đang được mượn" (NFR-2, 3.11) — read-model CÔNG KHAI NỘI BỘ cho member: snapshot
   * hiện tại, CHỈ display name + máy + khung. AD-5: KHÔNG sub/email, KHÔNG filter theo người,
   * KHÔNG phân trang lịch sử. Sort theo hạn trả tăng dần (sắp trả trước).
   */
  listInUseNow() {
    return this.read.listInUseNow();
  }

  /**
   * Bảng "Máy đang mượn" (7.4) — read-model realtime cho trang chủ.
   * Trả: MỌI ticket in_use (delivered) toàn hệ + vé chờ nhận/chờ duyệt của CHÍNH caller.
   * AD-5: read-only join, KHÔNG sub/email — chỉ full_name; borrowerName hiện cho mọi vai
   * (chốt 2026-07-09, khác in-use-now). Map trạng thái: in_use↔delivered, awaiting_pickup↔pending,
   * pending_approval(long-term)↔held (AD-16). is_overdue = cờ reversible (AD-14) cho badge+sort.
   */
  listBoard(callerSub: string) {
    return this.read.listBoard(callerSub);
  }



  /**
   * Ghi vết lần thử THUA (AC 4) — NGOÀI transaction quyết định (tx đó đã rollback theo throw,
   * appendWithin trong tx sẽ mất vết). Best-effort: lỗi audit không che lỗi gốc.
   */


  approveRequest(ticketId: string, version: number, actorSub: string) {
    return this.approval.approveRequest(ticketId, version, actorSub);
  }

  rejectRequest(ticketId: string, version: number, reason: string, actorSub: string) {
    return this.approval.rejectRequest(ticketId, version, reason, actorSub);
  }

  /**
   * Chuyển 1 ticket pending_approval quá giờ nhận → cancelled TRONG tx cho trước:
   * ticket→cancelled, booking held→cancelled, audit actor=system. Không mở tx mới.
   */


  /**
   * Sweep handler (AD-9, 3.5b): request `pending_approval` có giờ nhận đã trôi qua →
   * tự hết hạn, nhả khung, quota giải phóng, audit actor=system. Idempotent: mỗi ticket
   * re-lock + re-check pending_approval + pickup<now trong tx riêng (chạy lại vô hại).
   * Deadline derive từ Postgres → Redis chết/sống, sweep kế bù hết. Trả số ticket expire.
   */
  expireStalePendingApprovals() {
    return this.approval.expireStalePendingApprovals();
  }

  /**
   * Expire-on-conflict (AD-9): trong tx submit, giải phóng dòng `held` (pending_approval)
   * trên máy `assetId` chồng khung [from,to) mà giờ nhận (lower) đã qua. CHỈ held quá giờ —
   * không đụng booking còn hạn / đang mượn.
   * KHÔNG đụng `pending` (awaiting_pickup) trễ giờ nhận: khung còn hiệu lực (upper>now) nghĩa là
   * member VẪN giữ chỗ hợp lệ (đang được nhắc pickup) — không cướp; còn khi upper<now thì booking
   * mới của B (from≥now) không thể chồng nên không có "SLOT_TAKEN giả" (review Epic 3 F4).
   * THỨ TỰ KHÓA ticket → booking (giống sweep) để KHÔNG deadlock (review Med): tìm ticket_id
   * (không FOR UPDATE booking) → khóa ticket trước → cancelExpiredWithin update booking sau.
   */
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

  /**
   * Sweep handler (AD-14, 3.8): ticket `in_use` có booking `delivered` quá hạn trả
   * (upper period < now) chưa gắn cờ → bật is_overdue + overdue_marked_at (một lần, COALESCE
   * — không ghi đè). CHỈ cờ, KHÔNG đụng booking.state. Idempotent. KHÔNG phát mail (5.3 chủ).
   */
  markOverdue() {
    return this.sweep.markOverdue();
  }

  listOverdue() {
    return this.read.listOverdue();
  }

  /** Gắn ảnh (đã upload qua /admin/files) vào ticket theo phase + ghi note handover. */
  private async attachHandoverArtifacts(
    tx: Pick<Database, 'execute'>,
    ticketId: string,
    assetId: string,
    phase: 'deliver' | 'return',
    note: string | null,
    photoIds: string[],
    actorSub: string,
  ): Promise<void> {
    if (note && note.trim()) {
      await tx.execute(sql`
        INSERT INTO asset_note (asset_id, kind, note, actor)
        VALUES (${assetId}, 'handover', ${note.trim()}, ${actorSub})
      `);
    }
    // Kiểm ảnh tồn tại TRƯỚC khi link — photoId ma → 400 sạch (không để FK 23503 thành 500
    // rollback cả thao tác giao/nhận — review Med Bug1).
    const uniquePhotoIds = [...new Set(photoIds)];
    if (uniquePhotoIds.length > 0) {
      const found = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM files
        WHERE id IN (${sql.join(
          uniquePhotoIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      `);
      if ((found.rows[0]?.n ?? 0) !== uniquePhotoIds.length) {
        throw new BadRequestException({
          code: 'FILE_NOT_FOUND',
          message: 'Ảnh đính kèm không tồn tại — upload lại.',
        });
      }
    }
    for (const fileId of photoIds) {
      await tx.execute(sql`
        INSERT INTO ticket_file (ticket_id, file_id, phase)
        VALUES (${ticketId}, ${fileId}, ${phase})
        ON CONFLICT (ticket_id, file_id) DO NOTHING
      `);
    }
  }

  /** Đọc ticket + asset của booking chiếm chỗ, khóa FOR UPDATE; kiểm version. */
  private async lockTicketForHandover(
    tx: Pick<Database, 'execute'>,
    ticketId: string,
    version: number,
    expectState: string,
  ): Promise<{ assetId: string }> {
    const rows = await tx.execute<{
      state: string;
      version: number;
      kind: string;
      asset_id: string | null;
    }>(sql`
      SELECT t.state, t.version, t.kind,
        (SELECT b.asset_id FROM booking b
           WHERE b.ticket_id = t.id
             AND b.state IN (${sql.join(
               OCCUPYING_STATES.map((s) => sql`${s}`),
               sql`, `,
             )})
           ORDER BY lower(b.period) LIMIT 1) AS asset_id
      FROM ticket t WHERE t.id = ${ticketId} FOR UPDATE
    `);
    if (rows.rows.length === 0) {
      throw new NotFoundException({
        code: 'TICKET_NOT_FOUND',
        message: 'Không tìm thấy ticket này.',
      });
    }
    const t = rows.rows[0];
    // Chuỗi định kỳ giao/nhận TỪNG buổi qua RecurringLifecycleService — KHÔNG dùng luồng
    // ticket-level này (nếu không: 1 click chuyển hết mọi buổi, bỏ qua deriveParentState).
    if (t.kind === 'recurring') {
      throw new ConflictException({
        code: 'IS_RECURRING',
        message: 'Chuỗi định kỳ giao/nhận theo từng buổi.',
      });
    }
    if (t.version !== version) {
      throw new ConflictException({
        code: 'STALE_VERSION',
        message: 'Ticket vừa được cập nhật — vui lòng tải lại.',
      });
    }
    if (t.state !== expectState) {
      throw new ConflictException({
        code: 'INVALID_STATE',
        message: `Ticket không ở trạng thái phù hợp thao tác này.`,
      });
    }
    if (!t.asset_id) {
      throw new ConflictException({
        code: 'NO_BOOKING',
        message: 'Ticket không có booking đang hoạt động.',
      });
    }
    return { assetId: t.asset_id };
  }

  /** Admin xác nhận "Đã giao" (FR-14): awaiting_pickup → in_use, booking pending → delivered. */
  async deliver(
    ticketId: string,
    version: number,
    note: string | null,
    photoIds: string[],
    actorSub: string,
  ): Promise<{ id: string; state: string }> {
    return this.db.transaction(async (tx) => {
      const { assetId } = await this.lockTicketForHandover(
        tx,
        ticketId,
        version,
        'awaiting_pickup',
      );
      await tx.execute(sql`
        UPDATE ticket SET state = 'in_use', delivered_at = now(),
          version = version + 1, updated_at = now()
        WHERE id = ${ticketId}
      `);
      await tx.execute(sql`
        UPDATE booking SET state = 'delivered', version = version + 1, updated_at = now()
        WHERE ticket_id = ${ticketId} AND state = 'pending'
      `);
      await this.attachHandoverArtifacts(
        tx,
        ticketId,
        assetId,
        'deliver',
        note,
        photoIds,
        actorSub,
      );
      await this.audit.appendWithin(tx, {
        actor: actorSub,
        action: 'tickets.deliver',
        objectType: 'ticket',
        objectId: ticketId,
        detail: { photos: photoIds.length },
      });
      return { id: ticketId, state: 'in_use' };
    });
  }

  /** Admin xác nhận "Đã nhận" (FR-14/17): in_use → closed, booking delivered → returned.
   * Note BẮT BUỘC (controller ép) → asset_note handover. Trả sớm = close sớm (không kiểm giờ). */
  async returnTicket(
    ticketId: string,
    version: number,
    note: string,
    photoIds: string[],
    actorSub: string,
  ): Promise<{ id: string; state: string }> {
    return this.db.transaction(async (tx) => {
      const { assetId } = await this.lockTicketForHandover(
        tx,
        ticketId,
        version,
        'in_use',
      );
      // 4.1 AC5: nhả yêu cầu gia hạn treo (nếu có) trong CÙNG transaction close.
      await this.extension.expireHeldWithin(tx, ticketId);
      // Close → gỡ cờ is_overdue (hết hiển thị) nhưng GIỮ overdue_marked_at (FR-42 "từng quá hạn").
      // closed_at ghi một lần (marker báo cáo 6.1); returned_at là thời điểm nhận trả.
      await tx.execute(sql`
        UPDATE ticket SET state = 'closed', returned_at = now(),
          closed_at = COALESCE(closed_at, now()),
          is_overdue = false, version = version + 1, updated_at = now()
        WHERE id = ${ticketId}
      `);
      await tx.execute(sql`
        UPDATE booking SET state = 'returned', version = version + 1, updated_at = now()
        WHERE ticket_id = ${ticketId} AND state = 'delivered'
      `);
      await this.attachHandoverArtifacts(
        tx,
        ticketId,
        assetId,
        'return',
        note,
        photoIds,
        actorSub,
      );
      await this.audit.appendWithin(tx, {
        actor: actorSub,
        action: 'tickets.return',
        objectType: 'ticket',
        objectId: ticketId,
        detail: { photos: photoIds.length },
      });
      return { id: ticketId, state: 'closed' };
    });
  }

  listAssetHandovers(assetId: string, page = 1, pageSize = 20) {
    return this.read.listAssetHandovers(assetId, page, pageSize);
  }

  /**
   * UP-5.5: liệt kê ảnh đính kèm một ticket (fileId + phase) để FE dựng gallery/lightbox.
   * Cùng chốt quyền như getTicketPhoto: CHỦ ticket hoặc admin/sa. Chỉ meta id — stream
   * vẫn đi qua route serve từng file (đã kiểm ticket_file lần nữa).
   */
  listTicketPhotos(ticketId: string, requesterSub: string, requesterRole: string) {
    return this.read.listTicketPhotos(ticketId, requesterSub, requesterRole);
  }

  /**
   * Mở ảnh đính kèm ticket (NFR-8/AD-6): CHỈ chủ ticket HOẶC admin/sa. File phải thuộc
   * ticket (ticket_file) — chống đọc file id bất kỳ. Trả stream qua FilesService.
   */
  getTicketPhoto(ticketId: string, fileId: string, requesterSub: string, requesterRole: string) {
    return this.read.getTicketPhoto(ticketId, fileId, requesterSub, requesterRole);
  }

  /**
   * Sweep handler (FR-16, 3.9): ticket `awaiting_pickup` CHƯA giao đã trôi qua hết hạn mượn
   * (booking pending upper < now) → closed + close_reason='no_show', booking cancelled (KHÔNG
   * returned), khung nhả, quota giải phóng; audit actor=system. Idempotent (per-ticket re-check).
   * KHÔNG đụng in_use (đã giao → luồng overdue 3.8).
   */
  autoCloseNoShow() {
    return this.sweep.autoCloseNoShow();
  }

  /**
   * Sweep handler (FR-26, 3.9): booking `pending` (ticket awaiting_pickup) đã tới giờ nhận
   * (lower < now) NHƯNG chưa hết hạn (upper > now) và CHƯA nhắc → set pickup_reminder_at + ghi
   * outbox 'pickup_reminder' MỘT LẦN/booking (marker chống lặp 180 event; party phiên 7).
   * Payload chỉ id (AD-11). Mail consumer là Epic 5.
   */
  emitPickupReminders() {
    return this.sweep.emitPickupReminders();
  }
}
