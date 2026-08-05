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
import { deriveParentState } from './derive-parent-state';

type Tx = Pick<Database, 'execute'>;

/**
 * Vòng đời chuỗi định kỳ sau khi tạo (4.5a/4.5b): duyệt cả chuỗi, giao-nhận TỪNG buổi,
 * no-show per-buổi — mọi transition cập nhật state cha qua `deriveParentState` TRONG CÙNG tx
 * + FOR UPDATE cha (AD-4, party phiên 7). File riêng (granularity).
 */
@Injectable()
export class RecurringLifecycleService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
  ) {}

  /** Duyệt CẢ chuỗi (4.5a AC1): mọi buổi held→pending; cha → awaiting_pickup (derive). */
  async approveChain(
    ticketId: string,
    version: number,
    actorSub: string,
  ): Promise<{ id: string; state: string }> {
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockParent(tx, ticketId, version, 'pending_approval');
        await tx.execute(sql`
          UPDATE booking SET state = 'pending', version = version + 1, updated_at = now()
          WHERE ticket_id = ${ticketId} AND kind = 'recurring' AND state = 'held'
        `);
        await deriveParentState(tx, ticketId);
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'tickets.recurring_approve',
          objectType: 'ticket',
          objectId: ticketId,
          detail: {},
        });
        return { id: ticketId, state: 'awaiting_pickup' };
      });
    } catch (error) {
      throw mapBookingPgError(error);
    }
  }

  /** Từ chối cả chuỗi (4.5a AC1): mọi buổi cancelled; cha → rejected + lý do (AD-16). */
  async rejectChain(
    ticketId: string,
    version: number,
    reason: string,
    actorSub: string,
  ): Promise<{ id: string; state: string }> {
    return await this.db.transaction(async (tx) => {
      await this.lockParent(tx, ticketId, version, 'pending_approval');
      await tx.execute(sql`
        UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
        WHERE ticket_id = ${ticketId} AND kind = 'recurring' AND state = 'held'
      `);
      await tx.execute(sql`
        UPDATE ticket SET state = 'rejected', reject_reason = ${reason},
          version = version + 1, updated_at = now()
        WHERE id = ${ticketId}
      `);
      await this.audit.appendWithin(tx, {
        actor: actorSub,
        action: 'tickets.recurring_reject',
        objectType: 'ticket',
        objectId: ticketId,
        detail: { reason },
      });
      return { id: ticketId, state: 'rejected' };
    });
  }

  /** Giao 1 buổi (4.5a AC2): pending→delivered; cha derive. Lock ticket→booking. */
  async deliverSession(
    bookingId: string,
    version: number,
    note: string | null,
    photoIds: string[],
    actorSub: string,
  ): Promise<{ id: string }> {
    return this.sessionTransition(
      bookingId,
      version,
      'pending',
      'delivered',
      'deliver',
      note,
      photoIds,
      actorSub,
    );
  }

  /** Nhận 1 buổi (4.5a AC2): delivered→returned; note BẮT BUỘC; cha derive. */
  async returnSession(
    bookingId: string,
    version: number,
    note: string,
    photoIds: string[],
    actorSub: string,
  ): Promise<{ id: string }> {
    if (!note || !note.trim()) {
      throw new BadRequestException({
        code: 'NOTE_REQUIRED',
        message: 'Nhận buổi BẮT BUỘC ghi chú tình trạng.',
      });
    }
    return this.sessionTransition(
      bookingId,
      version,
      'delivered',
      'returned',
      'return',
      note,
      photoIds,
      actorSub,
    );
  }

  /** Sweep no-show per-buổi (4.5a AC3): buổi recurring pending upper<now → cancelled; cha derive. */
  async autoCloseNoShowRecurringSessions(): Promise<number> {
    const cands = await this.db.execute<{ id: string; ticket_id: string }>(sql`
      SELECT id, ticket_id FROM booking
      WHERE kind = 'recurring' AND state = 'pending' AND upper(period) < now()
    `);
    let n = 0;
    for (const c of cands.rows) {
      const done = await this.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM ticket WHERE id = ${c.ticket_id} FOR UPDATE`,
        );
        const r = await tx.execute<{
          state: string;
          expired: boolean | null;
        }>(sql`
          SELECT state, upper(period) < now() AS expired
          FROM booking WHERE id = ${c.id} AND kind = 'recurring' FOR UPDATE
        `);
        const row = r.rows[0];
        if (!row || row.state !== 'pending' || row.expired !== true)
          return false;
        await tx.execute(sql`
          UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
          WHERE id = ${c.id}
        `);
        await deriveParentState(tx, c.ticket_id);
        await this.audit.appendWithin(tx, {
          actor: 'system',
          action: 'tickets.session_no_show',
          objectType: 'ticket',
          objectId: c.ticket_id,
          detail: { bookingId: c.id },
        });
        return true;
      });
      if (done) n++;
    }
    return n;
  }

  /**
   * Hủy MỘT buổi lẻ (4.6): buổi CHƯA giao (held/pending). Member chỉ hủy buổi CỦA MÌNH và
   * TRƯỚC giờ nhận (lower>now); Admin hủy được cả sau giờ nhận. delivered/terminal → 409.
   * Lock ticket→booking, deriveParentState (cha về terminal ngay nếu là buổi cuối) → quota nhả.
   */
  async cancelSession(
    bookingId: string,
    version: number,
    actorSub: string,
    isAdmin: boolean,
  ): Promise<{ id: string; ticketState: string }> {
    return await this.db.transaction(async (tx) => {
      const ref = await tx.execute<{
        ticket_id: string;
        borrower_sub: string;
      }>(sql`
        SELECT b.ticket_id, t.borrower_sub
        FROM booking b JOIN ticket t ON t.id = b.ticket_id
        WHERE b.id = ${bookingId} AND b.kind = 'recurring'
      `);
      if (ref.rows.length === 0) {
        throw new NotFoundException({
          code: 'SESSION_NOT_FOUND',
          message: 'Không tìm thấy buổi.',
        });
      }
      const ticketId = ref.rows[0].ticket_id;
      // IDOR: buổi của người khác → 403 (member); Admin bỏ qua.
      if (!isAdmin && ref.rows[0].borrower_sub !== actorSub) {
        throw new ForbiddenException({
          code: 'NOT_TICKET_OWNER',
          message: 'Bạn không có quyền với buổi này.',
        });
      }
      await tx.execute(
        sql`SELECT 1 FROM ticket WHERE id = ${ticketId} FOR UPDATE`,
      );
      const b = await tx.execute<{
        state: string;
        version: number;
        not_started: boolean;
      }>(sql`
        SELECT state, version, lower(period) > now() AS not_started
        FROM booking WHERE id = ${bookingId} FOR UPDATE
      `);
      const row = b.rows[0];
      if (!row) {
        throw new NotFoundException({
          code: 'SESSION_NOT_FOUND',
          message: 'Không tìm thấy buổi.',
        });
      }
      if (row.version !== version) {
        throw new ConflictException({
          code: 'STALE_VERSION',
          message: 'Buổi vừa được cập nhật — vui lòng tải lại.',
        });
      }
      // AD-16: chỉ buổi CHƯA TỪNG giao mới kết thúc bằng cancelled.
      if (row.state !== 'held' && row.state !== 'pending') {
        throw new ConflictException({
          code: 'CANNOT_CANCEL_SESSION',
          message:
            'Buổi đã giao hoặc đã kết thúc — không thể hủy (đi luồng nhận trả).',
        });
      }
      // Member: đã tới giờ nhận thì không hủy được (như FR-11). Admin: được.
      if (!isAdmin && !row.not_started) {
        throw new ConflictException({
          code: 'PICKUP_PASSED',
          message: 'Đã tới giờ nhận buổi này — không thể hủy.',
        });
      }
      await tx.execute(sql`
        UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
        WHERE id = ${bookingId}
      `);
      await deriveParentState(tx, ticketId);
      const ts = await tx.execute<{ state: string }>(sql`
        SELECT state FROM ticket WHERE id = ${ticketId}
      `);
      await this.audit.appendWithin(tx, {
        actor: actorSub,
        action: 'tickets.session_cancel',
        objectType: 'ticket',
        objectId: ticketId,
        detail: { bookingId, by: isAdmin ? 'admin' : 'member' },
      });
      return { id: bookingId, ticketState: ts.rows[0].state };
    });
  }

  // --- helpers -------------------------------------------------------------

  private async lockParent(
    tx: Tx,
    ticketId: string,
    version: number,
    expectState: string,
  ): Promise<void> {
    const t = await tx.execute<{
      state: string;
      version: number;
      kind: string;
    }>(sql`
      SELECT state, version, kind FROM ticket WHERE id = ${ticketId} FOR UPDATE
    `);
    if (t.rows.length === 0) {
      throw new NotFoundException({
        code: 'TICKET_NOT_FOUND',
        message: 'Không tìm thấy chuỗi.',
      });
    }
    if (t.rows[0].kind !== 'recurring') {
      throw new ConflictException({
        code: 'NOT_RECURRING',
        message: 'Ticket này không phải chuỗi định kỳ.',
      });
    }
    if (t.rows[0].version !== version) {
      throw new ConflictException({
        code: 'STALE_VERSION',
        message: 'Chuỗi vừa được cập nhật — vui lòng tải lại.',
      });
    }
    if (t.rows[0].state !== expectState) {
      throw new ConflictException({
        code: 'INVALID_STATE',
        message: 'Chuỗi không ở trạng thái phù hợp thao tác này.',
      });
    }
  }

  private async sessionTransition(
    bookingId: string,
    version: number,
    fromState: string,
    toState: string,
    phase: 'deliver' | 'return',
    note: string | null,
    photoIds: string[],
    actorSub: string,
  ): Promise<{ id: string }> {
    return await this.db.transaction(async (tx) => {
      // Thứ tự khóa ticket → booking (chống deadlock với sweep song song).
      const ref = await tx.execute<{ ticket_id: string; asset_id: string }>(sql`
        SELECT ticket_id, asset_id FROM booking
        WHERE id = ${bookingId} AND kind = 'recurring'
      `);
      if (ref.rows.length === 0) {
        throw new NotFoundException({
          code: 'SESSION_NOT_FOUND',
          message: 'Không tìm thấy buổi.',
        });
      }
      const ticketId = ref.rows[0].ticket_id;
      await tx.execute(
        sql`SELECT 1 FROM ticket WHERE id = ${ticketId} FOR UPDATE`,
      );
      const b = await tx.execute<{ state: string; version: number }>(sql`
        SELECT state, version FROM booking WHERE id = ${bookingId} FOR UPDATE
      `);
      if (b.rows[0].version !== version) {
        throw new ConflictException({
          code: 'STALE_VERSION',
          message: 'Buổi vừa được cập nhật — vui lòng tải lại.',
        });
      }
      if (b.rows[0].state !== fromState) {
        throw new ConflictException({
          code: 'INVALID_STATE',
          message: 'Buổi không ở trạng thái phù hợp thao tác này.',
        });
      }
      // FL-3: ghi mốc giao/trả THEO BUỔI (delivered_at/returned_at trên booking) để tab
      // Mượn-trả hiện đúng mốc từng buổi thay vì mốc cha (NULL/sai). Giữ mốc còn lại.
      await tx.execute(sql`
        UPDATE booking SET state = ${toState}, version = version + 1, updated_at = now(),
          delivered_at = CASE WHEN ${phase} = 'deliver' THEN now() ELSE delivered_at END,
          returned_at = CASE WHEN ${phase} = 'return' THEN now() ELSE returned_at END
        WHERE id = ${bookingId}
      `);
      await this.attachArtifacts(
        tx,
        ticketId,
        ref.rows[0].asset_id,
        phase,
        note,
        photoIds,
        actorSub,
      );
      await deriveParentState(tx, ticketId);
      await this.audit.appendWithin(tx, {
        actor: actorSub,
        action: `tickets.session_${phase}`,
        objectType: 'ticket',
        objectId: ticketId,
        detail: { bookingId, photos: photoIds.length },
      });
      return { id: bookingId };
    });
  }

  /** Note tình trạng → asset_note; ảnh → ticket_file (kiểm tồn tại; mẫu attachHandoverArtifacts). */
  private async attachArtifacts(
    tx: Tx,
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
    const ids = [...new Set(photoIds)];
    if (ids.length > 0) {
      const found = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM files
        WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
      `);
      if ((found.rows[0]?.n ?? 0) !== ids.length) {
        throw new BadRequestException({
          code: 'FILE_NOT_FOUND',
          message: 'Ảnh đính kèm không tồn tại — upload lại.',
        });
      }
      for (const fileId of ids) {
        await tx.execute(sql`
          INSERT INTO ticket_file (ticket_id, file_id, phase)
          VALUES (${ticketId}, ${fileId}, ${phase})
          ON CONFLICT (ticket_id, file_id) DO NOTHING
        `);
      }
    }
  }
}
