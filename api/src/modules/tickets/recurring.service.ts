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
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { SystemConfigService } from '../config/system-config.service';
import { OutboxService } from '../outbox/outbox.service';
import { ACTIVE_TICKET_STATES } from './ticket-states';

export interface RecurringSession {
  from: string;
  to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ngày VN (yyyy-mm-dd) của một mốc — để so "cùng ngày" + khóa tuần ISO. */
function vnDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
  });
}
/** Khóa tuần ISO (thứ Hai VN của tuần chứa mốc) — 2 buổi cùng khóa = cùng tuần. */
function weekKey(iso: string): string {
  const s = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
  });
  const v = new Date(s);
  const mondayOffset = (v.getDay() + 6) % 7;
  v.setDate(v.getDate() - mondayOffset);
  v.setHours(0, 0, 0, 0);
  return v.toISOString().slice(0, 10);
}

/**
 * Chuỗi mượn định kỳ (Epic 4.4) — file riêng (granularity). Mỗi buổi = 1 dòng
 * `booking kind='recurring'` trên CÙNG máy; all-or-nothing 1 transaction (AD-3).
 */
@Injectable()
export class RecurringService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly config: SystemConfigService,
    private readonly audit: AuditWriterService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Hàng đợi giao/nhận từng buổi (4.5a AC2): buổi recurring còn pending (chờ giao) hoặc
   * delivered (chờ nhận). Kèm cha + máy + người mượn + cờ quá hạn cho badge. Sort giờ tăng dần.
   */
  async listSessionQueue(): Promise<
    Array<{
      id: string;
      version: number;
      ticketId: string;
      state: string;
      borrowerName: string | null;
      assetCode: string | null;
      from: string | null;
      to: string | null;
      isOverdue: boolean;
    }>
  > {
    const rows = await this.db.execute<{
      id: string;
      version: number;
      ticket_id: string;
      state: string;
      borrower_name: string | null;
      asset_code: string | null;
      from_ts: string | null;
      to_ts: string | null;
      is_overdue: boolean;
    }>(sql`
      SELECT b.id, b.version, b.ticket_id, b.state,
        u.full_name AS borrower_name, a.code AS asset_code,
        lower(b.period) AS from_ts, upper(b.period) AS to_ts,
        (b.state = 'delivered' AND upper(b.period) < now()) AS is_overdue
      FROM booking b
      JOIN ticket t ON t.id = b.ticket_id
      LEFT JOIN users u ON u.sub = t.borrower_sub
      LEFT JOIN assets a ON a.id = b.asset_id
      WHERE b.kind = 'recurring' AND b.state IN ('pending', 'delivered')
      ORDER BY is_overdue DESC, lower(b.period) ASC
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      version: r.version,
      ticketId: r.ticket_id,
      state: r.state,
      borrowerName: r.borrower_name,
      assetCode: r.asset_code,
      from: r.from_ts ? new Date(r.from_ts).toISOString() : null,
      to: r.to_ts ? new Date(r.to_ts).toISOString() : null,
      isOverdue: r.is_overdue,
    }));
  }

  /**
   * Validate buổi app-level (dùng chung submitRecurring + createRecurringForMember):
   * cùng ngày VN, 1 buổi/tuần, ≤30 ngày, buổi đầu tương lai + trong window. Throw chỉ rõ index.
   */
  private async validateSessions(sessions: RecurringSession[]): Promise<void> {
    if (sessions.length === 0) {
      throw new BadRequestException({
        code: 'RECUR_EMPTY',
        message: 'Chuỗi phải có ít nhất một buổi.',
      });
    }
    const weeks = new Set<string>();
    sessions.forEach((s, i) => {
      const fromMs = new Date(s.from).getTime();
      const toMs = new Date(s.to).getTime();
      if (!(toMs > fromMs)) {
        throw new BadRequestException({
          code: 'INVALID_RANGE',
          message: `Buổi ${i + 1}: giờ trả phải sau giờ nhận.`,
          index: i,
        });
      }
      // "Cùng ngày" VN (to-1ms để buổi kết đúng nửa đêm vẫn tính ngày trước)
      if (vnDay(s.from) !== vnDay(new Date(toMs - 1).toISOString())) {
        throw new BadRequestException({
          code: 'INVALID_RANGE',
          message: `Buổi ${i + 1}: giờ nhận và giờ trả phải cùng ngày.`,
          index: i,
        });
      }
      const wk = weekKey(s.from);
      if (weeks.has(wk)) {
        throw new BadRequestException({
          code: 'RECUR_WEEK_DUP',
          message: `Buổi ${i + 1}: mỗi tuần chỉ được một buổi.`,
          index: i,
        });
      }
      weeks.add(wk);
    });
    const froms = sessions.map((s) => new Date(s.from).getTime());
    const tos = sessions.map((s) => new Date(s.to).getTime());
    const spanStart = Math.min(...froms);
    const spanEnd = Math.max(...tos);
    if (spanEnd - spanStart > 30 * DAY_MS) {
      throw new BadRequestException({
        code: 'RECUR_SPAN',
        message: 'Tổng chuỗi không vượt 30 ngày.',
      });
    }
    // Window CHỈ áp buổi đầu (buổi sớm nhất) — buổi sau được vượt window.
    const windowDays = await this.config.getBookingWindowDays();
    if (spanStart < Date.now()) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: 'Buổi đầu phải ở tương lai.',
      });
    }
    if (spanStart - Date.now() > windowDays * DAY_MS) {
      throw new BadRequestException({
        code: 'BOOKING_WINDOW',
        message: `Buổi đầu chỉ được đặt trong ${windowDays} ngày tới.`,
      });
    }
  }

  async submitRecurring(
    assetId: string,
    sessions: RecurringSession[],
    borrowerSub: string,
  ): Promise<{ ticketId: string; count: number }> {
    await this.validateSessions(sessions);
    const quota = await this.config.getActiveTicketQuota();

    try {
      return await this.db.transaction(async (tx) => {
        const u = await tx.execute<{ can_recurring: boolean }>(sql`
          SELECT can_recurring FROM users WHERE sub = ${borrowerSub} FOR UPDATE
        `);
        if (u.rows.length === 0) {
          throw new NotFoundException({
            code: 'USER_NOT_FOUND',
            message: 'Không tìm thấy tài khoản.',
          });
        }
        if (!u.rows[0].can_recurring) {
          throw new ForbiddenException({
            code: 'RECUR_NOT_ALLOWED',
            message: 'Bạn chưa được cấp quyền đặt định kỳ.',
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
          throw new ConflictException({
            code: 'QUOTA_EXCEEDED',
            message: `Bạn đã đạt tối đa ${quota} lượt mượn đang hoạt động.`,
          });
        }
        const ticketRows = await tx.execute<{ id: string }>(sql`
          INSERT INTO ticket (kind, state, borrower_sub, created_by_sub)
          VALUES ('recurring', 'pending_approval', ${borrowerSub}, ${borrowerSub})
          RETURNING id
        `);
        const ticketId = ticketRows.rows[0].id;
        // All-or-nothing: buổi kẹt EXCLUDE → poison tx → rollback CẢ chuỗi, báo index.
        for (let i = 0; i < sessions.length; i++) {
          try {
            await tx.execute(sql`
              INSERT INTO booking (ticket_id, asset_id, kind, state, period)
              VALUES (${ticketId}, ${assetId}, 'recurring', 'held',
                tstzrange(${sessions[i].from}, ${sessions[i].to}, '[)'))
            `);
          } catch (e) {
            (e as { stuckSession?: number }).stuckSession = i;
            throw e;
          }
        }
        await this.audit.appendWithin(tx, {
          actor: borrowerSub,
          action: 'tickets.create_recurring',
          objectType: 'ticket',
          objectId: ticketId,
          detail: { assetId, count: sessions.length },
        });
        // 5.2: chuỗi định kỳ LUÔN cần duyệt → mail nhóm Admin ngay (cùng tx, AD-11).
        await this.outbox.enqueueWithin(tx, 'approval_requested', { ticketId });
        return { ticketId, count: sessions.length };
      });
    } catch (error) {
      const stuck = (error as { stuckSession?: number }).stuckSession;
      const mapped = mapBookingPgError(error);
      if (
        stuck !== undefined &&
        mapped instanceof ConflictException &&
        (mapped.getResponse() as { code?: string }).code === 'SLOT_TAKEN'
      ) {
        throw new ConflictException({
          code: 'SLOT_TAKEN',
          message: `Buổi ${stuck + 1} trùng lịch máy — chọn giờ khác cho buổi này.`,
          stuckSession: stuck,
        });
      }
      throw mapped;
    }
  }

  /**
   * Admin đặt chuỗi định kỳ HỘ member (7.5) — BỎ QUA quyền can_recurring + quota (như FR-12
   * create-for), VẪN validate buổi + EXCLUDE all-or-nothing (AD-3). Coi như ĐÃ DUYỆT:
   * ticket 'awaiting_pickup' + mỗi buổi 'pending' (khác submit: pending_approval/held) — KHÔNG mail duyệt.
   * borrower phải là member ≠ actor. department (nếu gửi) validate active trong tx.
   */
  async createRecurringForMember(
    assetId: string,
    sessions: RecurringSession[],
    borrowerSub: string,
    actorSub: string,
    departmentId?: string | null,
  ): Promise<{ ticketId: string; count: number }> {
    if (borrowerSub === actorSub) {
      throw new ForbiddenException({
        code: 'SELF_CREATE_FORBIDDEN',
        message: 'Admin không tạo hộ cho chính mình (không đi luồng mượn).',
      });
    }
    await this.validateSessions(sessions);
    try {
      return await this.db.transaction(async (tx) => {
        const u = await tx.execute<{ role: string }>(sql`
          SELECT role FROM users WHERE sub = ${borrowerSub}
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
        if (departmentId) {
          const d = await tx.execute<{ active: boolean }>(sql`
            SELECT active FROM department WHERE id = ${departmentId}
          `);
          if (d.rows.length === 0 || !d.rows[0].active) {
            throw new BadRequestException({
              code: 'DEPARTMENT_INVALID',
              message: 'Phòng ban không hợp lệ.',
            });
          }
        }
        const ticketRows = await tx.execute<{ id: string }>(sql`
          INSERT INTO ticket (kind, state, borrower_sub, created_by_sub)
          VALUES ('recurring', 'awaiting_pickup', ${borrowerSub}, ${actorSub})
          RETURNING id
        `);
        const ticketId = ticketRows.rows[0].id;
        for (let i = 0; i < sessions.length; i++) {
          try {
            await tx.execute(sql`
              INSERT INTO booking (ticket_id, asset_id, kind, state, period, department_id)
              VALUES (${ticketId}, ${assetId}, 'recurring', 'pending',
                tstzrange(${sessions[i].from}, ${sessions[i].to}, '[)'),
                ${departmentId ?? null})
            `);
          } catch (e) {
            (e as { stuckSession?: number }).stuckSession = i;
            throw e;
          }
        }
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'tickets.create_recurring_for',
          objectType: 'ticket',
          objectId: ticketId,
          detail: { borrower: borrowerSub, assetId, count: sessions.length },
        });
        return { ticketId, count: sessions.length };
      });
    } catch (error) {
      const stuck = (error as { stuckSession?: number }).stuckSession;
      const mapped = mapBookingPgError(error);
      if (
        stuck !== undefined &&
        mapped instanceof ConflictException &&
        (mapped.getResponse() as { code?: string }).code === 'SLOT_TAKEN'
      ) {
        throw new ConflictException({
          code: 'SLOT_TAKEN',
          message: `Buổi ${stuck + 1} trùng lịch máy — chọn giờ khác cho buổi này.`,
          stuckSession: stuck,
        });
      }
      throw mapped;
    }
  }

  /**
   * Sweep (4.4 AC4, party phiên 7): chuỗi pending_approval có buổi held sớm nhất (chưa hủy)
   * đã quá giờ nhận → CẢ CHUỖI cancelled (all-or-nothing). `FOR UPDATE` buổi + kiểm lại anchor
   * tại thời điểm ghi — anchor vừa bị hủy sát nút → rollback, sweep sau tính lại.
   */
  async expireStalePendingRecurring(): Promise<number> {
    const candidates = await this.db.execute<{ id: string }>(sql`
      SELECT t.id FROM ticket t
      WHERE t.kind = 'recurring' AND t.state = 'pending_approval'
        AND EXISTS (
          SELECT 1 FROM booking b
          WHERE b.ticket_id = t.id AND b.state = 'held' AND lower(b.period) < now()
        )
    `);
    let n = 0;
    for (const c of candidates.rows) {
      const done = await this.db.transaction(async (tx) => {
        const tk = await tx.execute<{ state: string }>(sql`
          SELECT state FROM ticket WHERE id = ${c.id} FOR UPDATE
        `);
        if (tk.rows[0]?.state !== 'pending_approval') return false;
        // Khóa mọi buổi rồi kiểm lại anchor (buổi held sớm nhất < now).
        await tx.execute(
          sql`SELECT 1 FROM booking WHERE ticket_id = ${c.id} FOR UPDATE`,
        );
        const anchor = await tx.execute<{ expired: boolean | null }>(sql`
          SELECT min(lower(period)) < now() AS expired
          FROM booking WHERE ticket_id = ${c.id} AND state = 'held'
        `);
        if (anchor.rows[0]?.expired !== true) return false;
        await tx.execute(sql`
          UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
          WHERE ticket_id = ${c.id} AND state = 'held'
        `);
        await tx.execute(sql`
          UPDATE ticket SET state = 'cancelled', version = version + 1, updated_at = now()
          WHERE id = ${c.id}
        `);
        await this.audit.appendWithin(tx, {
          actor: 'system',
          action: 'tickets.recurring_expire',
          objectType: 'ticket',
          objectId: c.id,
          detail: {},
        });
        return true;
      });
      if (done) n++;
    }
    return n;
  }
}
