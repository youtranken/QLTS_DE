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
import { assertBookingDuration } from '../../common/booking-window';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { SystemConfigService } from '../config/system-config.service';

/**
 * Luồng gia hạn (Epic 4.1–4.3) — tách khỏi TicketsService (granularity). Extension là dòng
 * booking `kind='extension'` state='held' period=[hạn_cũ, hạn_mới) (AD-3); kết `cancelled` +
 * `result ∈ {approved,rejected,expired}`. KHÔNG gửi mail (FR-47).
 */
@Injectable()
export class ExtensionService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly config: SystemConfigService,
    private readonly audit: AuditWriterService,
  ) {}

  /** Member xin gia hạn (4.1). period=[hạn_cũ, hạn_mới) — EXCLUDE chặn chồng khung (SLOT_TAKEN). */
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
          kind: string;
          version: number;
          is_overdue: boolean;
          extension_count: number;
          old_due: string | null;
          asset_id: string | null;
          old_due_passed: boolean | null;
          has_pending_ext: boolean;
        }>(sql`
          SELECT t.borrower_sub, t.state, t.kind, t.version, t.is_overdue, t.extension_count,
            (SELECT upper(b.period) FROM booking b
               WHERE b.ticket_id = t.id AND b.state = 'delivered' LIMIT 1) AS old_due,
            (SELECT b.asset_id FROM booking b
               WHERE b.ticket_id = t.id AND b.state = 'delivered' LIMIT 1) AS asset_id,
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
        // 4.5a AC4: buổi lẻ định kỳ KHÔNG gia hạn.
        if (t.kind === 'recurring') {
          throw new ConflictException({
            code: 'INVALID_STATE',
            message: 'Chuỗi định kỳ không gia hạn từng buổi.',
          });
        }
        // Quá hạn thật (DB now(), không tin cờ trễ sweep) → cấm gia hạn (AC1).
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
        return { id: ins.rows[0].id };
      });
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }

  /** Hàng đợi Chờ gia hạn (4.2) — AD-5 chỉ display name. */
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
   * Admin DUYỆT (4.2, AD-3 party 6). THỨ TỰ SINH TỬ: (2a) cancel extension held TRƯỚC → (2b)
   * mở rộng period gốc. Đảo lại: UPDATE mở rộng tự đụng EXCLUDE (per-statement). Khóa
   * ticket→booking chống deadlock với returnTicket. count+1, gỡ overdue (giữ marker AD-14).
   */
  async approveExtension(
    extensionId: string,
    version: number,
    actorSub: string,
  ): Promise<{ id: string; state: string }> {
    try {
      return await this.db.transaction(async (tx) => {
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
        if (e.new_due_passed) {
          throw new ConflictException({
            code: 'EXTENSION_EXPIRED',
            message: 'Hạn mới đã ở quá khứ — không duyệt được.',
          });
        }
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
        await tx.execute(sql`
          UPDATE booking SET state = 'cancelled', result = 'approved',
            version = version + 1, updated_at = now()
          WHERE id = ${extensionId}
        `);
        await tx.execute(sql`
          UPDATE booking
          SET period = tstzrange(${orig.rows[0].from_ts}, ${e.new_due}, '[)'),
            version = version + 1, updated_at = now()
          WHERE id = ${orig.rows[0].id}
        `);
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

  /** Admin TỪ CHỐI (4.2): extension → cancelled+result='rejected', nhả khung. */
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
   * Admin gia hạn THẲNG (đường B) — đặt hạn trả mới ngay, KHÔNG qua bước request/duyệt.
   * Không giới hạn SỐ LẦN (admin quyết định); cho phép cả ticket ĐÃ QUÁ HẠN (gia hạn cứu).
   * Vẫn chặn: không đang mượn, buổi định kỳ, hạn mới ≤ hạn hiện tại, hạn mới ở quá khứ,
   * tổng thời lượng vượt trần (audit H-2), va khung máy (SLOT_TAKEN).
   * Hủy mọi yêu cầu gia hạn đang treo của ticket (bị thay thế bởi quyết định admin).
   */
  async adminExtend(
    ticketId: string,
    newDueIso: string,
    actorSub: string,
  ): Promise<{ id: string; state: string }> {
    const maxDurationHours = await this.config.getMaxBookingDurationHours();
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx.execute<{ state: string; kind: string }>(
          sql`SELECT state, kind FROM ticket WHERE id = ${ticketId} FOR UPDATE`,
        );
        if (rows.rows.length === 0) {
          throw new NotFoundException({
            code: 'TICKET_NOT_FOUND',
            message: 'Không tìm thấy ticket.',
          });
        }
        const t = rows.rows[0];
        if (t.state !== 'in_use') {
          throw new ConflictException({
            code: 'INVALID_STATE',
            message: 'Chỉ gia hạn được ticket đang mượn.',
          });
        }
        if (t.kind === 'recurring') {
          throw new ConflictException({
            code: 'INVALID_STATE',
            message: 'Chuỗi định kỳ không gia hạn từng buổi.',
          });
        }
        const orig = await tx.execute<{
          id: string;
          from_ts: string;
          old_due: string;
          db_now: string;
        }>(sql`
          SELECT id, lower(period) AS from_ts, upper(period) AS old_due, now()::text AS db_now
          FROM booking
          WHERE ticket_id = ${ticketId} AND state = 'delivered'
          FOR UPDATE LIMIT 1
        `);
        if (orig.rows.length === 0) {
          throw new ConflictException({
            code: 'INVALID_STATE',
            message: 'Ticket không còn booking đang mượn.',
          });
        }
        const newDueMs = new Date(newDueIso).getTime();
        if (newDueMs <= new Date(orig.rows[0].old_due).getTime()) {
          throw new BadRequestException({
            code: 'INVALID_RANGE',
            message: 'Hạn mới phải sau hạn trả hiện tại.',
          });
        }
        // Với ticket ĐÃ QUÁ HẠN (old_due < now), chặn đặt hạn mới vẫn ở quá khứ (old_due<newDue<now):
        // sẽ set is_overdue=false rồi markOverdue bật lại trong ≤60s → nhấp nháy trạng thái (audit M6).
        if (newDueMs <= new Date(orig.rows[0].db_now).getTime()) {
          throw new BadRequestException({
            code: 'INVALID_RANGE',
            message: 'Hạn mới phải ở tương lai (sau thời điểm hiện tại).',
          });
        }
        // Trần thời lượng (audit H-2): adminExtend ghi thẳng cột period, KHÔNG đi qua
        // parseBookingWindow — nếu bỏ sót đây thì vá ở submit chỉ chặn cửa trước.
        assertBookingDuration(
          new Date(orig.rows[0].from_ts),
          new Date(newDueIso),
          maxDurationHours,
        );
        // Hủy yêu cầu gia hạn treo (nếu có) TRƯỚC khi nới period gốc (tránh đụng EXCLUDE).
        await tx.execute(sql`
          UPDATE booking SET state = 'cancelled', result = 'expired',
            version = version + 1, updated_at = now()
          WHERE ticket_id = ${ticketId} AND kind = 'extension' AND state = 'held'
        `);
        await tx.execute(sql`
          UPDATE booking
          SET period = tstzrange(${orig.rows[0].from_ts}, ${newDueIso}, '[)'),
            version = version + 1, updated_at = now()
          WHERE id = ${orig.rows[0].id}
        `);
        await tx.execute(sql`
          UPDATE ticket SET extension_count = extension_count + 1, is_overdue = false,
            version = version + 1, updated_at = now()
          WHERE id = ${ticketId}
        `);
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'tickets.extension_admin',
          objectType: 'ticket',
          objectId: ticketId,
          detail: { newDue: newDueIso },
        });
        return { id: ticketId, state: 'in_use' };
      });
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }

  /** Sweep (4.3): extension held hạn cũ trôi qua → cancelled+result='expired'. Idempotent. */
  async expireStaleExtensions(): Promise<number> {
    const candidates = await this.db.execute<{
      id: string;
      ticket_id: string;
    }>(sql`
      SELECT id, ticket_id FROM booking
      WHERE kind = 'extension' AND state = 'held' AND lower(period) < now()
    `);
    let n = 0;
    for (const c of candidates.rows) {
      const done = await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM ticket WHERE id = ${c.ticket_id} FOR UPDATE`,
        );
        const r = await tx.execute<{
          state: string;
          expired: boolean | null;
        }>(sql`
          SELECT state, lower(period) < now() AS expired
          FROM booking WHERE id = ${c.id} AND kind = 'extension' FOR UPDATE
        `);
        const row = r.rows[0];
        if (!row || row.state !== 'held' || row.expired !== true) return false;
        await tx.execute(sql`
          UPDATE booking SET state = 'cancelled', result = 'expired',
            version = version + 1, updated_at = now()
          WHERE id = ${c.id}
        `);
        await this.audit.appendWithin(tx, {
          actor: 'system',
          action: 'tickets.extension_expire',
          objectType: 'ticket',
          objectId: c.ticket_id,
          detail: { extensionId: c.id },
        });
        return true;
      });
      if (done) n++;
    }
    return n;
  }

  /** 4.1 AC5: đóng ticket → extension held treo → cancelled+result='expired'. Gọi trong tx close. */
  async expireHeldWithin(
    tx: Pick<Database, 'execute'>,
    ticketId: string,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE booking SET state = 'cancelled', result = 'expired',
        version = version + 1, updated_at = now()
      WHERE ticket_id = ${ticketId} AND kind = 'extension' AND state = 'held'
    `);
  }
}
