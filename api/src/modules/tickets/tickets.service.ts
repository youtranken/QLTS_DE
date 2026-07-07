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

  /**
   * Hàng đợi Admin "Chờ duyệt" (FR-13) — request >48h/định kỳ đang giữ chỗ (held).
   * Admin THẤY tên người mượn (hàng đợi nội bộ, khác read-model AD-5 công khai).
   */
  async listPendingApproval(): Promise<
    Array<{
      id: string;
      version: number;
      borrowerSub: string;
      borrowerName: string | null;
      assetCode: string | null;
      from: string | null;
      to: string | null;
      createdAt: string;
    }>
  > {
    const rows = await this.db.execute<{
      id: string;
      version: number;
      borrower_sub: string;
      borrower_name: string | null;
      asset_code: string | null;
      from_ts: string | null;
      to_ts: string | null;
      created_at: string;
    }>(sql`
      SELECT t.id, t.version, t.borrower_sub,
        u.full_name AS borrower_name, a.code AS asset_code,
        lower(b.period) AS from_ts, upper(b.period) AS to_ts, t.created_at
      FROM ticket t
      LEFT JOIN users u ON u.sub = t.borrower_sub
      LEFT JOIN booking b ON b.ticket_id = t.id AND b.state = 'held'
      LEFT JOIN assets a ON a.id = b.asset_id
      WHERE t.state = 'pending_approval'
      ORDER BY t.created_at ASC, b.id
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      version: r.version,
      borrowerSub: r.borrower_sub,
      borrowerName: r.borrower_name,
      assetCode: r.asset_code,
      from: r.from_ts ? new Date(r.from_ts).toISOString() : null,
      to: r.to_ts ? new Date(r.to_ts).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /** Đọc ticket pending_approval trong tx + kiểm version/state chung cho approve+reject. */
  private async lockPendingForDecision(
    tx: Pick<Database, 'execute' | 'insert'>,
    ticketId: string,
    version: number,
  ): Promise<{ pickupMs: number | null }> {
    const rows = await tx.execute<{
      state: string;
      version: number;
      pickup_ts: string | null;
    }>(sql`
      SELECT t.state, t.version,
        (SELECT min(lower(b.period)) FROM booking b
           WHERE b.ticket_id = t.id AND b.state = 'held') AS pickup_ts
      FROM ticket t WHERE t.id = ${ticketId} FOR UPDATE
    `);
    if (rows.rows.length === 0) {
      throw new NotFoundException({
        code: 'TICKET_NOT_FOUND',
        message: 'Không tìm thấy request này.',
      });
    }
    const t = rows.rows[0];
    // Kiểm VERSION trước (AD-4, AC4): 2 Admin cùng version → người thua (state ĐÃ đổi +
    // version ĐÃ bump) nhận STALE_VERSION. INVALID_STATE dành cho version-đúng-nhưng-state-sai
    // (client cầm version mới của ticket đã rời pending_approval).
    if (t.version !== version) {
      throw new ConflictException({
        code: 'STALE_VERSION',
        message: 'Request vừa được người khác xử lý — vui lòng tải lại.',
      });
    }
    if (t.state !== 'pending_approval') {
      throw new ConflictException({
        code: 'INVALID_STATE',
        message: 'Request không còn ở trạng thái chờ duyệt.',
      });
    }
    return { pickupMs: t.pickup_ts ? new Date(t.pickup_ts).getTime() : null };
  }

  /**
   * Ghi vết lần thử THUA (AC 4) — NGOÀI transaction quyết định (tx đó đã rollback theo throw,
   * appendWithin trong tx sẽ mất vết). Best-effort: lỗi audit không che lỗi gốc.
   */
  private async auditFailedDecision(
    action: string,
    ticketId: string,
    actorSub: string,
    error: unknown,
  ): Promise<void> {
    if (!(error instanceof ConflictException)) return;
    const resp = error.getResponse();
    const code =
      typeof resp === 'object' && resp && 'code' in resp
        ? String(resp.code)
        : 'CONFLICT';
    await this.audit.append({
      actor: actorSub,
      action: `${action}_failed`,
      objectType: 'ticket',
      objectId: ticketId,
      detail: { code },
    });
  }

  /** Admin duyệt request (FR-13): held → pending, ticket → awaiting_pickup. */
  async approveRequest(
    ticketId: string,
    version: number,
    actorSub: string,
  ): Promise<{ id: string; state: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        const { pickupMs } = await this.lockPendingForDecision(
          tx,
          ticketId,
          version,
        );
        // Guard AD-4: không duyệt booking có giờ nhận đã ở quá khứ
        if (pickupMs !== null && pickupMs < Date.now()) {
          throw new ConflictException({
            code: 'PICKUP_PASSED',
            message: 'Giờ nhận đã trôi qua — không thể duyệt; đề nghị hủy.',
          });
        }
        await tx.execute(sql`
          UPDATE ticket SET state = 'awaiting_pickup', version = version + 1, updated_at = now()
          WHERE id = ${ticketId}
        `);
        await tx.execute(sql`
          UPDATE booking SET state = 'pending', version = version + 1, updated_at = now()
          WHERE ticket_id = ${ticketId} AND state = 'held'
        `);
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'tickets.approve',
          objectType: 'ticket',
          objectId: ticketId,
          detail: {},
        });
        return { id: ticketId, state: 'awaiting_pickup' };
      });
    } catch (error) {
      // AC 4: ghi vết lần thử THUA (STALE/INVALID_STATE) ngoài tx đã rollback
      await this.auditFailedDecision(
        'tickets.approve',
        ticketId,
        actorSub,
        error,
      );
      throw error;
    }
  }

  /** Admin từ chối (FR-13): bắt buộc lý do; held → cancelled (nhả khung), ticket → rejected. */
  async rejectRequest(
    ticketId: string,
    version: number,
    reason: string,
    actorSub: string,
  ): Promise<{ id: string; state: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockPendingForDecision(tx, ticketId, version);
        // reject_reason set CÙNG lúc state='rejected' (không lách CHECK 0017)
        await tx.execute(sql`
          UPDATE ticket SET state = 'rejected', reject_reason = ${reason},
            version = version + 1, updated_at = now()
          WHERE id = ${ticketId}
        `);
        await tx.execute(sql`
          UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
          WHERE ticket_id = ${ticketId} AND state = 'held'
        `);
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'tickets.reject',
          objectType: 'ticket',
          objectId: ticketId,
          detail: { reason },
        });
        return { id: ticketId, state: 'rejected' };
      });
    } catch (error) {
      await this.auditFailedDecision(
        'tickets.reject',
        ticketId,
        actorSub,
        error,
      );
      throw error;
    }
  }

  /**
   * Chuyển 1 ticket pending_approval quá giờ nhận → cancelled TRONG tx cho trước:
   * ticket→cancelled, booking held→cancelled, audit actor=system. Không mở tx mới.
   */
  private async cancelExpiredWithin(
    tx: Pick<Database, 'execute' | 'insert'>,
    ticketId: string,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE ticket SET state = 'cancelled', version = version + 1, updated_at = now()
      WHERE id = ${ticketId}
    `);
    await tx.execute(sql`
      UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
      WHERE ticket_id = ${ticketId} AND state = 'held'
    `);
    await this.audit.appendWithin(tx, {
      actor: 'system',
      action: 'tickets.auto_expire',
      objectType: 'ticket',
      objectId: ticketId,
      detail: { reason: 'expired_pending_approval' },
    });
  }

  /**
   * Sweep handler (AD-9, 3.5b): request `pending_approval` có giờ nhận đã trôi qua →
   * tự hết hạn, nhả khung, quota giải phóng, audit actor=system. Idempotent: mỗi ticket
   * re-lock + re-check pending_approval + pickup<now trong tx riêng (chạy lại vô hại).
   * Deadline derive từ Postgres → Redis chết/sống, sweep kế bù hết. Trả số ticket expire.
   */
  async expireStalePendingApprovals(): Promise<number> {
    const candidates = await this.db.execute<{ id: string }>(sql`
      SELECT t.id FROM ticket t
      WHERE t.state = 'pending_approval'
        AND EXISTS (
          SELECT 1 FROM booking b
          WHERE b.ticket_id = t.id AND b.state = 'held' AND lower(b.period) < now()
        )
    `);
    let n = 0;
    for (const c of candidates.rows) {
      const done = await this.db.transaction(async (tx) => {
        // Đồng hồ MỘT nguồn = Postgres now() (không trộn Date.now() Node — review Low).
        const r = await tx.execute<{
          state: string;
          expired: boolean | null;
        }>(sql`
          SELECT t.state,
            (SELECT min(lower(b.period)) < now() FROM booking b
               WHERE b.ticket_id = t.id AND b.state = 'held') AS expired
          FROM ticket t WHERE t.id = ${c.id} FOR UPDATE
        `);
        const row = r.rows[0];
        if (!row || row.state !== 'pending_approval') return false;
        if (row.expired !== true) return false;
        await this.cancelExpiredWithin(tx, c.id);
        return true;
      });
      if (done) n++;
    }
    return n;
  }

  /**
   * Expire-on-conflict (AD-9): trong tx submit, giải phóng dòng `held` (pending_approval)
   * trên máy `assetId` chồng khung [from,to) mà giờ nhận (lower) đã qua. CHỈ held quá giờ —
   * không đụng booking còn hạn / đang mượn.
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
        await this.cancelExpiredWithin(tx, row.ticket_id);
      }
    }
  }
}
