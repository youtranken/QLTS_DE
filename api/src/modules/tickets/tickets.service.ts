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
import { parseBookingWindow } from '../../common/booking-window';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { SystemConfigService } from '../config/system-config.service';
import { FilesService } from '../files/files.service';
import { OutboxService } from '../outbox/outbox.service';
import { AssetsService } from '../assets/assets.service';
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
  isOverdue: boolean;
  overdueMinutes: number | null;
  extensionCount: number;
  hasPendingExtension: boolean;
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
    private readonly files: FilesService,
    private readonly outbox: OutboxService,
    private readonly assets: AssetsService,
  ) {}

  /**
   * Orchestrator vòng đời máy (3.10, AD-1 Tickets→Assets): mở 1 tx, gọi AssetsService đổi
   * trạng thái máy (lock/unlock/dispose/setPool) rồi cascade hủy booking tương lai TRONG
   * CÙNG transaction. Khóa/thanh lý/gỡ-pool làm máy KHÔNG bookable → hủy held/pending.
   */
  async lockAssetCascade(
    assetId: string,
    reason: string,
    eta: string | null,
    version: number,
    actorSub: string,
    notify = true,
  ) {
    // Task 2 (3.10): caller bọc mapPgError — lỗi PG-level trong cascade (deadlock 40P01
    // review F11, trigger P0001…) dịch 409 thay vì 500 thô. Nest exception (STALE_VERSION…)
    // đi qua nguyên vẹn vì mapBookingPgError trả về error gốc khi không khớp code.
    // notify (3.13): Admin tick "báo user" → enqueue mail booking_cancelled; tắt → chỉ audit.
    try {
      return await this.db.transaction(async (tx) => {
        const res = await this.assets.lockWithin(
          tx,
          assetId,
          reason,
          eta,
          version,
          actorSub,
        );
        const cancelled = await this.cancelFutureBookings(
          tx,
          assetId,
          actorSub,
          notify,
        );
        return { ...res, cancelledBookings: cancelled };
      });
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }

  async unlockAsset(assetId: string, version: number, actorSub: string) {
    try {
      return await this.db.transaction((tx) =>
        this.assets.unlockWithin(tx, assetId, version, actorSub),
      );
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }

  async disposeAssetCascade(
    assetId: string,
    version: number,
    actorSub: string,
    notify = true,
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        const res = await this.assets.disposeWithin(
          tx,
          assetId,
          version,
          actorSub,
        );
        const cancelled = await this.cancelFutureBookings(
          tx,
          assetId,
          actorSub,
          notify,
        );
        return { ...res, cancelledBookings: cancelled };
      });
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }

  async setPoolCascade(
    assetId: string,
    isPool: boolean,
    version: number,
    actorSub: string,
    notify = true,
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        const res = await this.assets.setPoolWithin(
          tx,
          assetId,
          isPool,
          version,
          actorSub,
        );
        // Gỡ pool (isPool=false) → máy không bookable → cascade; bật pool → không.
        if (!isPool) {
          const cancelled = await this.cancelFutureBookings(
            tx,
            assetId,
            actorSub,
            notify,
          );
          return { ...res, cancelledBookings: cancelled };
        }
        return res;
      });
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }

  /**
   * Hủy MỌI booking `held`/`pending` (occupying nhưng CHƯA giao) normal/recurring trên máy
   * (AC2): future + stale-past-pickup (không rơi khe AD-15). `delivered` (in_use) GIỮ —
   * Admin thu hồi tay. Ticket pending_approval/awaiting_pickup → cancelled; ghi outbox FR-27
   * (mail Epic 5) mỗi booking. Trả số booking bị hủy. (Extension kind → Epic 4.)
   */
  private async cancelFutureBookings(
    tx: Pick<Database, 'execute' | 'insert'>,
    assetId: string,
    actorSub: string,
    notify: boolean,
  ): Promise<number> {
    // THỨ TỰ KHÓA ticket → booking (khớp expireStaleHoldsForAsset/sweep/approve — chống
    // deadlock 40P01 với approve/cancel/sweep song song; review 3.10 Med). Tìm ticket_id
    // (không khóa) → khóa ticket TRƯỚC → hủy booking của ticket đó trên máy này.
    const tickets = await tx.execute<{ ticket_id: string }>(sql`
      SELECT DISTINCT ticket_id FROM booking
      WHERE asset_id = ${assetId}
        AND state IN ('held', 'pending')
        AND kind IN ('normal', 'recurring')
    `);
    let count = 0;
    for (const { ticket_id } of tickets.rows) {
      await tx.execute(
        sql`SELECT 1 FROM ticket WHERE id = ${ticket_id} FOR UPDATE`,
      );
      const cancelled = await tx.execute<{ id: string }>(sql`
        UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
        WHERE ticket_id = ${ticket_id} AND asset_id = ${assetId}
          AND state IN ('held', 'pending')
          AND kind IN ('normal', 'recurring')
        RETURNING id
      `);
      if (cancelled.rows.length === 0) continue;
      // ticket normal (1 booking) → cancelled. (Recurring Epic 4: cần deriveParentState.)
      await tx.execute(sql`
        UPDATE ticket SET state = 'cancelled', version = version + 1, updated_at = now()
        WHERE id = ${ticket_id}
          AND state IN ('pending_approval', 'awaiting_pickup')
      `);
      for (const b of cancelled.rows) {
        // 3.13: chỉ enqueue mail khi Admin tick "báo user"; audit ghi VÔ ĐIỀU KIỆN (audit ≠ mail).
        if (notify) {
          await this.outbox.enqueueWithin(tx, 'booking_cancelled', {
            ticketId: ticket_id,
            bookingId: b.id,
          });
        }
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'tickets.cascade_cancel',
          objectType: 'ticket',
          objectId: ticket_id,
          detail: { reason: 'asset_unbookable', bookingId: b.id, notified: notify },
        });
        count++;
      }
    }
    return count;
  }

  /**
   * Preview cascade (3.13, AC1) — READ-ONLY (KHÔNG mutate): trả những gì Khóa/Gỡ pool/Thanh lý
   * SẼ đụng để Admin xem trước rồi xác nhận. 2 nhóm: (a) booking held/pending sẽ bị HỦY;
   * (b) ticket in_use (booking delivered) đang giữ máy cần Admin THU HỒI tay (3.6). AD-5: chỉ
   * display name, KHÔNG sub/email. Không mở transaction ghi, không đổi asset.status.
   */
  async previewLifecycleCascade(assetId: string): Promise<{
    futureCancellations: Array<{
      ticketId: string;
      borrowerName: string | null;
      from: string | null;
      to: string | null;
      state: string;
    }>;
    inUseRecalls: Array<{
      ticketId: string;
      borrowerName: string | null;
      from: string | null;
      to: string | null;
    }>;
  }> {
    const [future, inUse] = await Promise.all([
      this.db.execute<{
        ticket_id: string;
        borrower_name: string | null;
        from_ts: string | null;
        to_ts: string | null;
        state: string;
      }>(sql`
        SELECT b.ticket_id, u.full_name AS borrower_name,
          lower(b.period) AS from_ts, upper(b.period) AS to_ts, b.state
        FROM booking b
        JOIN ticket t ON t.id = b.ticket_id
        LEFT JOIN users u ON u.sub = t.borrower_sub
        WHERE b.asset_id = ${assetId}
          AND b.state IN ('held', 'pending')
          AND b.kind IN ('normal', 'recurring')
        ORDER BY lower(b.period)
      `),
      this.db.execute<{
        ticket_id: string;
        borrower_name: string | null;
        from_ts: string | null;
        to_ts: string | null;
      }>(sql`
        SELECT b.ticket_id, u.full_name AS borrower_name,
          lower(b.period) AS from_ts, upper(b.period) AS to_ts
        FROM booking b
        JOIN ticket t ON t.id = b.ticket_id AND t.state = 'in_use'
        LEFT JOIN users u ON u.sub = t.borrower_sub
        WHERE b.asset_id = ${assetId} AND b.state = 'delivered'
        ORDER BY upper(b.period)
      `),
    ]);
    const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
    return {
      futureCancellations: future.rows.map((r) => ({
        ticketId: r.ticket_id,
        borrowerName: r.borrower_name,
        from: iso(r.from_ts),
        to: iso(r.to_ts),
        state: r.state,
      })),
      inUseRecalls: inUse.rows.map((r) => ({
        ticketId: r.ticket_id,
        borrowerName: r.borrower_name,
        from: iso(r.from_ts),
        to: iso(r.to_ts),
      })),
    };
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
    if (input.mode === 'schedule') {
      // đặt lịch tương lai: from≥now + trong window
      const windowDays = await this.config.getBookingWindowDays();
      parseBookingWindow(input.from, input.to, windowDays);
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
      pickup_passed: boolean | null;
      is_overdue: boolean;
      overdue_minutes: number | null;
      extension_count: number;
      has_pending_ext: boolean;
    }>(sql`
      SELECT t.id, t.state, t.kind, t.version, t.created_at,
        a.code AS asset_code,
        lower(b.period) AS from_ts, upper(b.period) AS to_ts,
        t.is_overdue, t.extension_count,
        CASE WHEN t.is_overdue THEN
          EXTRACT(EPOCH FROM (now() - upper(b.period)))::int / 60
          ELSE NULL END AS overdue_minutes,
        -- giờ nhận ĐÃ QUA chưa (F5: so bằng DB now(), không Date.now()) — tính TRÊN booking
        -- còn chiếm chỗ (bỏ cancelled/returned cũ; chống false-negative khi Epic 4 đa booking)
        (SELECT min(lower(b2.period)) < now() FROM booking b2
           WHERE b2.ticket_id = t.id
             AND b2.state IN (${sql.join(
               OCCUPYING_STATES.map((s) => sql`${s}`),
               sql`, `,
             )})) AS pickup_passed,
        -- 4.1: có yêu cầu gia hạn treo? (dòng extension held)
        EXISTS (SELECT 1 FROM booking be
           WHERE be.ticket_id = t.id AND be.kind = 'extension' AND be.state = 'held')
          AS has_pending_ext
      FROM ticket t
      -- 4.1 (G4): lọc kind<>'extension' → dòng extension KHÔNG nhân đôi ticket
      LEFT JOIN booking b ON b.ticket_id = t.id AND b.kind <> 'extension'
      LEFT JOIN assets a ON a.id = b.asset_id
      WHERE t.borrower_sub = ${borrowerSub}
      ORDER BY t.created_at DESC, b.id
    `);
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
      cancellable: this.isCancellable(r.state, r.pickup_passed),
      isOverdue: r.is_overdue,
      overdueMinutes: r.overdue_minutes,
      extensionCount: r.extension_count,
      hasPendingExtension: r.has_pending_ext,
    }));
  }

  /**
   * Hủy được: pending_approval bất kỳ lúc nào; awaiting_pickup CHỈ trước giờ nhận (FR-11).
   * `pickupPassed` derive từ DB now() (F5 — MỘT nguồn đồng hồ = Postgres, không trộn
   * Date.now() Node; đồng bộ với sweep expireStalePendingApprovals/autoCloseNoShow).
   */
  private isCancellable(state: string, pickupPassed: boolean | null): boolean {
    if (state === 'pending_approval') return true;
    if (state === 'awaiting_pickup') return pickupPassed !== true;
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
      if (!this.isCancellable(t.state, t.pickup_passed)) {
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

  /**
   * Hàng đợi Admin theo trạng thái (FR-45): chờ giao (awaiting_pickup) / đang mượn (in_use).
   * Kèm tên người mượn + máy + khung + version cho nút giao/nhận. Booking occupying của ticket.
   */
  async listQueue(ticketState: 'awaiting_pickup' | 'in_use'): Promise<
    Array<{
      id: string;
      version: number;
      borrowerName: string | null;
      assetCode: string | null;
      from: string | null;
      to: string | null;
      isOverdue: boolean;
      overdueMinutes: number | null;
    }>
  > {
    const rows = await this.db.execute<{
      id: string;
      version: number;
      borrower_name: string | null;
      asset_code: string | null;
      from_ts: string | null;
      to_ts: string | null;
      is_overdue: boolean;
      overdue_minutes: number | null;
    }>(sql`
      SELECT t.id, t.version, u.full_name AS borrower_name, a.code AS asset_code,
        lower(b.period) AS from_ts, upper(b.period) AS to_ts,
        t.is_overdue,
        -- F9: badge đỏ + thời lượng quá hạn NGAY trên queue đang mượn (3.8 Task 5)
        CASE WHEN t.is_overdue THEN
          EXTRACT(EPOCH FROM (now() - upper(b.period)))::int / 60
          ELSE NULL END AS overdue_minutes
      FROM ticket t
      LEFT JOIN users u ON u.sub = t.borrower_sub
      LEFT JOIN booking b ON b.ticket_id = t.id
        AND b.state IN (${sql.join(
          OCCUPYING_STATES.map((s) => sql`${s}`),
          sql`, `,
        )})
      LEFT JOIN assets a ON a.id = b.asset_id
      WHERE t.state = ${ticketState}
      -- quá hạn nổi lên đầu (sort — 3.8 AC1), rồi tới giờ nhận/trả sớm nhất
      ORDER BY t.is_overdue DESC, lower(b.period) ASC, t.created_at
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      version: r.version,
      borrowerName: r.borrower_name,
      assetCode: r.asset_code,
      from: r.from_ts ? new Date(r.from_ts).toISOString() : null,
      to: r.to_ts ? new Date(r.to_ts).toISOString() : null,
      isOverdue: r.is_overdue,
      overdueMinutes: r.overdue_minutes,
    }));
  }

  /**
   * "Máy đang được mượn" (NFR-2, 3.11) — read-model CÔNG KHAI NỘI BỘ cho member: snapshot
   * hiện tại, CHỈ display name + máy + khung. AD-5: KHÔNG sub/email, KHÔNG filter theo người,
   * KHÔNG phân trang lịch sử. Sort theo hạn trả tăng dần (sắp trả trước).
   */
  async listInUseNow(): Promise<
    Array<{
      borrowerName: string | null;
      assetCode: string | null;
      from: string | null;
      to: string | null;
    }>
  > {
    const rows = await this.db.execute<{
      borrower_name: string | null;
      asset_code: string | null;
      from_ts: string | null;
      to_ts: string | null;
    }>(sql`
      SELECT u.full_name AS borrower_name, a.code AS asset_code,
        lower(b.period) AS from_ts, upper(b.period) AS to_ts
      FROM ticket t
      JOIN booking b ON b.ticket_id = t.id AND b.state = 'delivered'
      LEFT JOIN users u ON u.sub = t.borrower_sub
      LEFT JOIN assets a ON a.id = b.asset_id
      WHERE t.state = 'in_use'
      ORDER BY upper(b.period) ASC
    `);
    return rows.rows.map((r) => ({
      borrowerName: r.borrower_name,
      assetCode: r.asset_code,
      from: r.from_ts ? new Date(r.from_ts).toISOString() : null,
      to: r.to_ts ? new Date(r.to_ts).toISOString() : null,
    }));
  }

  /** Đọc ticket pending_approval trong tx + kiểm version/state chung cho approve+reject. */
  private async lockPendingForDecision(
    tx: Pick<Database, 'execute' | 'insert'>,
    ticketId: string,
    version: number,
  ): Promise<{ pickupPassed: boolean | null }> {
    const rows = await tx.execute<{
      state: string;
      version: number;
      pickup_passed: boolean | null;
    }>(sql`
      SELECT t.state, t.version,
        (SELECT min(lower(b.period)) < now() FROM booking b
           WHERE b.ticket_id = t.id AND b.state = 'held') AS pickup_passed
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
    return { pickupPassed: t.pickup_passed };
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
        const { pickupPassed } = await this.lockPendingForDecision(
          tx,
          ticketId,
          version,
        );
        // Guard AD-4: không duyệt booking có giờ nhận đã ở quá khứ (F5: DB now(), không Date.now())
        if (pickupPassed === true) {
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
      // F14: UPDATE held→pending kích trigger bookability → P0001 ASSET_UNAVAILABLE khi máy
      // vừa bị khóa/gỡ pool; map 409 thay vì 500 thô (đồng bộ submit/create-for).
      throw mapBookingPgError(error);
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
        await this.cancelExpiredWithin(tx, row.ticket_id);
      }
    }
  }

  /**
   * Sweep handler (AD-14, 3.8): ticket `in_use` có booking `delivered` quá hạn trả
   * (upper period < now) chưa gắn cờ → bật is_overdue + overdue_marked_at (một lần, COALESCE
   * — không ghi đè). CHỈ cờ, KHÔNG đụng booking.state. Idempotent. KHÔNG phát mail (5.3 chủ).
   */
  async markOverdue(): Promise<number> {
    const res = await this.db.execute<{ id: string }>(sql`
      UPDATE ticket t SET is_overdue = true,
        overdue_marked_at = COALESCE(t.overdue_marked_at, now()),
        updated_at = now()
      WHERE t.state = 'in_use' AND t.is_overdue = false
        AND EXISTS (
          SELECT 1 FROM booking b
          WHERE b.ticket_id = t.id AND b.state = 'delivered'
            AND upper(b.period) < now()
        )
      RETURNING t.id
    `);
    return res.rows.length;
  }

  /** Danh sách ticket đang quá hạn (dashboard 3.12) — sort thời lượng quá hạn giảm dần. */
  async listOverdue(): Promise<
    Array<{
      id: string;
      borrowerName: string | null;
      assetCode: string | null;
      dueAt: string | null;
      overdueMinutes: number;
    }>
  > {
    // DISTINCT ON (t.id): ticket nhiều booking delivered (định kỳ Epic 4) → 1 dòng/ticket,
    // lấy booking quá hạn LÂU nhất (upper sớm nhất). Sort ngoài theo thời lượng giảm dần.
    const rows = await this.db.execute<{
      id: string;
      borrower_name: string | null;
      asset_code: string | null;
      due_at: string | null;
      overdue_minutes: number;
    }>(sql`
      SELECT id, borrower_name, asset_code, due_at, overdue_minutes FROM (
        SELECT DISTINCT ON (t.id) t.id, u.full_name AS borrower_name, a.code AS asset_code,
          upper(b.period) AS due_at,
          EXTRACT(EPOCH FROM (now() - upper(b.period)))::int / 60 AS overdue_minutes
        FROM ticket t
        JOIN booking b ON b.ticket_id = t.id AND b.state = 'delivered'
        LEFT JOIN users u ON u.sub = t.borrower_sub
        LEFT JOIN assets a ON a.id = b.asset_id
        WHERE t.state = 'in_use' AND t.is_overdue = true
        ORDER BY t.id, upper(b.period) ASC
      ) q
      ORDER BY overdue_minutes DESC
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      borrowerName: r.borrower_name,
      assetCode: r.asset_code,
      dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
      overdueMinutes: r.overdue_minutes,
    }));
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
      asset_id: string | null;
    }>(sql`
      SELECT t.state, t.version,
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
  /**
   * Member xin gia hạn (4.1, FR-18/19/20/47, AD-3): MỘT dòng booking kind='extension' state='held'
   * period=[hạn_trả_cũ, hạn_mới) — không bao trùm period gốc. EXCLUDE chặn chồng khung (SLOT_TAKEN).
   * KHÔNG enqueue mail (FR-47). Chủ ticket + optimistic lock (AD-4/5).
   */
  async requestExtension(
    ticketId: string,
    newDueIso: string,
    borrowerSub: string,
    version: number,
  ): Promise<{ id: string }> {
    const days = await this.config.getExtensionDaysPerGrant();
    const maxGrants = await this.config.getExtensionMaxGrants();
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx.execute<{
          borrower_sub: string;
          state: string;
          version: number;
          is_overdue: boolean;
          extension_count: number;
          old_due: string | null;
          asset_id: string | null;
          old_due_passed: boolean | null;
          has_pending_ext: boolean;
        }>(sql`
          SELECT t.borrower_sub, t.state, t.version, t.is_overdue, t.extension_count,
            (SELECT upper(b.period) FROM booking b
               WHERE b.ticket_id = t.id AND b.state = 'delivered' LIMIT 1) AS old_due,
            (SELECT b.asset_id FROM booking b
               WHERE b.ticket_id = t.id AND b.state = 'delivered' LIMIT 1) AS asset_id,
            -- Hạn trả cũ ĐÃ QUA chưa — so bằng DB now() (không tin cờ is_overdue trễ sweep,
            -- review 4.1 MED). Quá hạn thật → cấm gia hạn (AC1) + chống new_due rơi vào quá khứ.
            (SELECT upper(b.period) < now() FROM booking b
               WHERE b.ticket_id = t.id AND b.state = 'delivered' LIMIT 1) AS old_due_passed,
            EXISTS (SELECT 1 FROM booking b
               WHERE b.ticket_id = t.id AND b.kind = 'extension' AND b.state = 'held')
              AS has_pending_ext
          FROM ticket t WHERE t.id = ${ticketId} FOR UPDATE
        `);
        if (rows.rows.length === 0) {
          throw new NotFoundException({
            code: 'TICKET_NOT_FOUND',
            message: 'Không tìm thấy ticket.',
          });
        }
        const t = rows.rows[0];
        if (t.borrower_sub !== borrowerSub) {
          throw new ForbiddenException({
            code: 'NOT_TICKET_OWNER',
            message: 'Bạn không có quyền với ticket này.',
          });
        }
        if (t.version !== version) {
          throw new ConflictException({
            code: 'STALE_VERSION',
            message: 'Ticket vừa được cập nhật — vui lòng tải lại.',
          });
        }
        if (t.state !== 'in_use') {
          throw new ConflictException({
            code: 'INVALID_STATE',
            message: 'Chỉ gia hạn được ticket đang mượn.',
          });
        }
        if (t.is_overdue || t.old_due_passed) {
          throw new ConflictException({
            code: 'TICKET_OVERDUE',
            message: 'Ticket đã quá hạn trả — chỉ còn cách trả máy.',
          });
        }
        if (t.has_pending_ext) {
          throw new ConflictException({
            code: 'EXTENSION_PENDING',
            message: 'Đang chờ duyệt một yêu cầu gia hạn cho ticket này.',
          });
        }
        if (t.extension_count >= maxGrants) {
          throw new ConflictException({
            code: 'EXTENSION_LIMIT',
            message: `Đã dùng hết ${maxGrants} lần gia hạn cho ticket này.`,
          });
        }
        if (!t.old_due || !t.asset_id) {
          throw new ConflictException({
            code: 'INVALID_STATE',
            message: 'Ticket chưa có booking đang mượn hợp lệ.',
          });
        }
        const oldMs = new Date(t.old_due).getTime();
        const newMs = new Date(newDueIso).getTime();
        if (newMs <= oldMs) {
          throw new BadRequestException({
            code: 'INVALID_RANGE',
            message: 'Hạn mới phải sau hạn trả hiện tại.',
          });
        }
        if (newMs - oldMs > days * 24 * 60 * 60 * 1000) {
          throw new BadRequestException({
            code: 'EXTENSION_TOO_LONG',
            message: `Mỗi lần gia hạn tối đa ${days} ngày.`,
          });
        }
        // AD-3: period=[hạn_cũ, hạn_mới) — không bao period gốc. EXCLUDE chặn chồng → SLOT_TAKEN.
        const ins = await tx.execute<{ id: string }>(sql`
          INSERT INTO booking (ticket_id, asset_id, kind, state, period)
          VALUES (${ticketId}, ${t.asset_id}, 'extension', 'held',
            tstzrange(${t.old_due}, ${newDueIso}, '[)'))
          RETURNING id
        `);
        await this.audit.appendWithin(tx, {
          actor: borrowerSub,
          action: 'tickets.extension_request',
          objectType: 'ticket',
          objectId: ticketId,
          detail: { newDue: newDueIso },
        });
        // FR-47: KHÔNG enqueue mail cho luồng gia hạn (giảm nhiễu).
        return { id: ins.rows[0].id };
      });
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }

  /** Hàng đợi Chờ gia hạn (4.2 AC1) — dòng extension held; AD-5 chỉ display name. */
  async listPendingExtensions(): Promise<
    Array<{
      extensionId: string;
      version: number;
      ticketId: string;
      borrowerName: string | null;
      assetCode: string | null;
      oldDue: string | null;
      newDue: string | null;
      usedCount: number;
    }>
  > {
    const rows = await this.db.execute<{
      extension_id: string;
      version: number;
      ticket_id: string;
      borrower_name: string | null;
      asset_code: string | null;
      old_due: string | null;
      new_due: string | null;
      used_count: number;
    }>(sql`
      SELECT e.id AS extension_id, e.version, e.ticket_id,
        u.full_name AS borrower_name, a.code AS asset_code,
        lower(e.period) AS old_due, upper(e.period) AS new_due,
        t.extension_count AS used_count
      FROM booking e
      JOIN ticket t ON t.id = e.ticket_id
      LEFT JOIN users u ON u.sub = t.borrower_sub
      LEFT JOIN assets a ON a.id = e.asset_id
      WHERE e.kind = 'extension' AND e.state = 'held'
      ORDER BY upper(e.period)
    `);
    const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
    return rows.rows.map((r) => ({
      extensionId: r.extension_id,
      version: r.version,
      ticketId: r.ticket_id,
      borrowerName: r.borrower_name,
      assetCode: r.asset_code,
      oldDue: iso(r.old_due),
      newDue: iso(r.new_due),
      usedCount: r.used_count,
    }));
  }

  /**
   * Admin DUYỆT gia hạn (4.2 AC2, AD-3 party phiên 6). THỨ TỰ SINH TỬ: (2a) cancel dòng
   * extension `held` TRƯỚC → (2b) mới mở rộng period booking gốc tới hạn mới. Đảo lại thì
   * UPDATE mở rộng tự đụng EXCLUDE (extension còn held chồng khung, EXCLUDE per-statement).
   * Extension KHÔNG thành delivered (FR-42). count+1, gỡ cờ overdue (giữ marker AD-14).
   */
  async approveExtension(
    extensionId: string,
    version: number,
    actorSub: string,
  ): Promise<{ id: string; state: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        // THỨ TỰ KHÓA ticket → booking (nhất quán cancelFutureBookings/expireStaleHoldsForAsset
        // — chống deadlock 40P01 với returnTicket song song; review 4.2 MED). Đọc ticket_id
        // (không khóa) → khóa TICKET trước → rồi mới khóa các dòng booking.
        const ref = await tx.execute<{ ticket_id: string }>(sql`
          SELECT ticket_id FROM booking
          WHERE id = ${extensionId} AND kind = 'extension'
        `);
        if (ref.rows.length === 0) {
          throw new NotFoundException({
            code: 'EXTENSION_NOT_FOUND',
            message: 'Không tìm thấy yêu cầu gia hạn.',
          });
        }
        await tx.execute(
          sql`SELECT 1 FROM ticket WHERE id = ${ref.rows[0].ticket_id} FOR UPDATE`,
        );
        // (1) khóa dòng extension (sau ticket)
        const ex = await tx.execute<{
          ticket_id: string;
          ext_version: number;
          state: string;
          new_due: string;
          new_due_passed: boolean;
        }>(sql`
          SELECT ticket_id, version AS ext_version, state,
            upper(period) AS new_due, upper(period) <= now() AS new_due_passed
          FROM booking WHERE id = ${extensionId} AND kind = 'extension' FOR UPDATE
        `);
        if (ex.rows.length === 0) {
          throw new NotFoundException({
            code: 'EXTENSION_NOT_FOUND',
            message: 'Không tìm thấy yêu cầu gia hạn.',
          });
        }
        const e = ex.rows[0];
        if (e.ext_version !== version) {
          throw new ConflictException({
            code: 'STALE_VERSION',
            message: 'Yêu cầu vừa được xử lý — vui lòng tải lại.',
          });
        }
        if (e.state !== 'held') {
          throw new ConflictException({
            code: 'INVALID_STATE',
            message: 'Yêu cầu gia hạn không còn ở trạng thái chờ duyệt.',
          });
        }
        // AC4: hạn MỚI đã ở quá khứ → không duyệt hồi tố (guard DB now()).
        if (e.new_due_passed) {
          throw new ConflictException({
            code: 'EXTENSION_EXPIRED',
            message: 'Hạn mới đã ở quá khứ — không duyệt được.',
          });
        }
        // (1b) khóa booking gốc delivered
        const orig = await tx.execute<{ id: string; from_ts: string }>(sql`
          SELECT id, lower(period) AS from_ts FROM booking
          WHERE ticket_id = ${e.ticket_id} AND state = 'delivered'
          FOR UPDATE LIMIT 1
        `);
        if (orig.rows.length === 0) {
          throw new ConflictException({
            code: 'INVALID_STATE',
            message: 'Ticket không còn booking đang mượn.',
          });
        }
        // (2a) cancel extension TRƯỚC (nhả held → không tự đụng EXCLUDE khi mở rộng)
        await tx.execute(sql`
          UPDATE booking SET state = 'cancelled', result = 'approved',
            version = version + 1, updated_at = now()
          WHERE id = ${extensionId}
        `);
        // (2b) mở rộng period booking gốc tới hạn mới
        await tx.execute(sql`
          UPDATE booking
          SET period = tstzrange(${orig.rows[0].from_ts}, ${e.new_due}, '[)'),
            version = version + 1, updated_at = now()
          WHERE id = ${orig.rows[0].id}
        `);
        // (3) ticket: +1 lần gia hạn, gỡ cờ quá hạn (GIỮ overdue_marked_at — AD-14)
        await tx.execute(sql`
          UPDATE ticket SET extension_count = extension_count + 1, is_overdue = false,
            version = version + 1, updated_at = now()
          WHERE id = ${e.ticket_id}
        `);
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'tickets.extension_approve',
          objectType: 'ticket',
          objectId: e.ticket_id,
          detail: { extensionId, newDue: e.new_due },
        });
        return { id: e.ticket_id, state: 'in_use' };
      });
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }

  /** Admin TỪ CHỐI gia hạn (4.2 AC3): extension → cancelled+result='rejected', nhả khung. */
  async rejectExtension(
    extensionId: string,
    version: number,
    reason: string,
    actorSub: string,
  ): Promise<{ id: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        const ex = await tx.execute<{
          ticket_id: string;
          ext_version: number;
          state: string;
        }>(sql`
          SELECT ticket_id, version AS ext_version, state
          FROM booking WHERE id = ${extensionId} AND kind = 'extension' FOR UPDATE
        `);
        if (ex.rows.length === 0) {
          throw new NotFoundException({
            code: 'EXTENSION_NOT_FOUND',
            message: 'Không tìm thấy yêu cầu gia hạn.',
          });
        }
        const e = ex.rows[0];
        if (e.ext_version !== version) {
          throw new ConflictException({
            code: 'STALE_VERSION',
            message: 'Yêu cầu vừa được xử lý — vui lòng tải lại.',
          });
        }
        if (e.state !== 'held') {
          throw new ConflictException({
            code: 'INVALID_STATE',
            message: 'Yêu cầu gia hạn không còn ở trạng thái chờ duyệt.',
          });
        }
        await tx.execute(sql`
          UPDATE booking SET state = 'cancelled', result = 'rejected',
            version = version + 1, updated_at = now()
          WHERE id = ${extensionId}
        `);
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'tickets.extension_reject',
          objectType: 'ticket',
          objectId: e.ticket_id,
          detail: { reason },
        });
        return { id: e.ticket_id };
      });
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }

  /**
   * 4.1 AC5: đóng ticket → dòng extension `held` treo → cancelled + result='expired', nhả khung.
   * Gọi TRONG transaction close (returnTicket…). Không có extension trên awaiting_pickup nên
   * no-show/cancelMyTicket không cần.
   */
  private async expireHeldExtensionWithin(
    tx: Pick<Database, 'execute'>,
    ticketId: string,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE booking SET state = 'cancelled', result = 'expired',
        version = version + 1, updated_at = now()
      WHERE ticket_id = ${ticketId} AND kind = 'extension' AND state = 'held'
    `);
  }

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
      await this.expireHeldExtensionWithin(tx, ticketId);
      // Close → gỡ cờ is_overdue (hết hiển thị) nhưng GIỮ overdue_marked_at (FR-42 "từng quá hạn").
      await tx.execute(sql`
        UPDATE ticket SET state = 'closed', returned_at = now(),
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

  /** Tab "Mượn-trả" của máy (FR-34): ticket/buổi của máy — người mượn, khung, giao/nhận, trạng thái. */
  async listAssetHandovers(
    assetId: string,
    page = 1,
    pageSize = 20,
  ): Promise<{
    items: unknown[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const offset = (page - 1) * pageSize;
    const [items, totalRows] = await Promise.all([
      this.db.execute<{
        ticket_id: string;
        state: string;
        borrower_name: string | null;
        from_ts: string;
        to_ts: string;
        delivered_at: string | null;
        returned_at: string | null;
        is_overdue: boolean;
        overdue_minutes: number | null;
      }>(sql`
        SELECT t.id AS ticket_id, t.state, u.full_name AS borrower_name,
          lower(b.period) AS from_ts, upper(b.period) AS to_ts,
          t.delivered_at, t.returned_at,
          t.is_overdue,
          -- F9: cờ/thời lượng quá hạn cho tab Mượn-trả (3.8 Task 4)
          CASE WHEN t.is_overdue THEN
            EXTRACT(EPOCH FROM (now() - upper(b.period)))::int / 60
            ELSE NULL END AS overdue_minutes
        FROM booking b
        JOIN ticket t ON t.id = b.ticket_id
        LEFT JOIN users u ON u.sub = t.borrower_sub
        WHERE b.asset_id = ${assetId} AND b.kind IN ('normal', 'recurring')
          AND b.state <> 'cancelled'
        ORDER BY lower(b.period) DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `),
      this.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM booking b
        WHERE b.asset_id = ${assetId} AND b.kind IN ('normal', 'recurring')
          AND b.state <> 'cancelled'
      `),
    ]);
    return {
      items: items.rows.map((r) => ({
        ticketId: r.ticket_id,
        state: r.state,
        stateLabel: TICKET_STATE_LABELS_VI[r.state as TicketState] ?? r.state,
        borrowerName: r.borrower_name,
        from: new Date(r.from_ts).toISOString(),
        to: new Date(r.to_ts).toISOString(),
        deliveredAt: r.delivered_at
          ? new Date(r.delivered_at).toISOString()
          : null,
        returnedAt: r.returned_at
          ? new Date(r.returned_at).toISOString()
          : null,
        isOverdue: r.is_overdue,
        overdueMinutes: r.overdue_minutes,
      })),
      total: totalRows.rows[0]?.n ?? 0,
      page,
      pageSize,
    };
  }

  /**
   * Mở ảnh đính kèm ticket (NFR-8/AD-6): CHỈ chủ ticket HOẶC admin/sa. File phải thuộc
   * ticket (ticket_file) — chống đọc file id bất kỳ. Trả stream qua FilesService.
   */
  async getTicketPhoto(
    ticketId: string,
    fileId: string,
    requesterSub: string,
    requesterRole: string,
  ) {
    const rows = await this.db.execute<{ borrower_sub: string }>(sql`
      SELECT t.borrower_sub FROM ticket t
      JOIN ticket_file tf ON tf.ticket_id = t.id AND tf.file_id = ${fileId}
      WHERE t.id = ${ticketId}
    `);
    if (rows.rows.length === 0) {
      throw new NotFoundException({
        code: 'PHOTO_NOT_FOUND',
        message: 'Không tìm thấy ảnh của ticket này.',
      });
    }
    const isAdmin = requesterRole === 'admin' || requesterRole === 'sa';
    if (!isAdmin && rows.rows[0].borrower_sub !== requesterSub) {
      throw new ForbiddenException({
        code: 'NOT_TICKET_OWNER',
        message: 'Bạn không có quyền xem ảnh này.',
      });
    }
    return this.files.openForDownload(fileId, requesterSub);
  }

  /**
   * Sweep handler (FR-16, 3.9): ticket `awaiting_pickup` CHƯA giao đã trôi qua hết hạn mượn
   * (booking pending upper < now) → closed + close_reason='no_show', booking cancelled (KHÔNG
   * returned), khung nhả, quota giải phóng; audit actor=system. Idempotent (per-ticket re-check).
   * KHÔNG đụng in_use (đã giao → luồng overdue 3.8).
   */
  async autoCloseNoShow(): Promise<number> {
    const candidates = await this.db.execute<{ id: string }>(sql`
      SELECT t.id FROM ticket t
      WHERE t.state = 'awaiting_pickup'
        AND EXISTS (
          SELECT 1 FROM booking b
          WHERE b.ticket_id = t.id AND b.state = 'pending' AND upper(b.period) < now()
        )
    `);
    let n = 0;
    for (const c of candidates.rows) {
      const done = await this.db.transaction(async (tx) => {
        const r = await tx.execute<{
          state: string;
          expired: boolean | null;
        }>(sql`
          SELECT t.state,
            (SELECT bool_and(upper(b.period) < now()) FROM booking b
               WHERE b.ticket_id = t.id AND b.state = 'pending') AS expired
          FROM ticket t WHERE t.id = ${c.id} FOR UPDATE
        `);
        const row = r.rows[0];
        if (!row || row.state !== 'awaiting_pickup' || row.expired !== true) {
          return false;
        }
        await tx.execute(sql`
          UPDATE ticket SET state = 'closed', close_reason = 'no_show',
            version = version + 1, updated_at = now()
          WHERE id = ${c.id}
        `);
        await tx.execute(sql`
          UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
          WHERE ticket_id = ${c.id} AND state = 'pending'
        `);
        await this.audit.appendWithin(tx, {
          actor: 'system',
          action: 'tickets.no_show',
          objectType: 'ticket',
          objectId: c.id,
          detail: { note: 'auto-close: no-show' },
        });
        return true;
      });
      if (done) n++;
    }
    return n;
  }

  /**
   * Sweep handler (FR-26, 3.9): booking `pending` (ticket awaiting_pickup) đã tới giờ nhận
   * (lower < now) NHƯNG chưa hết hạn (upper > now) và CHƯA nhắc → set pickup_reminder_at + ghi
   * outbox 'pickup_reminder' MỘT LẦN/booking (marker chống lặp 180 event; party phiên 7).
   * Payload chỉ id (AD-11). Mail consumer là Epic 5.
   */
  async emitPickupReminders(): Promise<number> {
    const due = await this.db.execute<{ id: string; ticket_id: string }>(sql`
      SELECT b.id, b.ticket_id FROM booking b
      JOIN ticket t ON t.id = b.ticket_id AND t.state = 'awaiting_pickup'
      WHERE b.state = 'pending'
        AND lower(b.period) < now() AND upper(b.period) > now()
        AND b.pickup_reminder_at IS NULL
    `);
    let n = 0;
    for (const row of due.rows) {
      const done = await this.db.transaction(async (tx) => {
        // Marker null-check trong tx (khóa dòng) → 2 sweep song song không ghi đúp
        const upd = await tx.execute<{ id: string }>(sql`
          UPDATE booking SET pickup_reminder_at = now()
          WHERE id = ${row.id} AND state = 'pending' AND pickup_reminder_at IS NULL
          RETURNING id
        `);
        if (upd.rows.length !== 1) return false;
        await this.outbox.enqueueWithin(tx, 'pickup_reminder', {
          ticketId: row.ticket_id,
          bookingId: row.id,
        });
        return true;
      });
      if (done) n++;
    }
    return n;
  }
}
