import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { mapBookingPgError } from '../../common/booking-errors';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { OutboxService } from '../outbox/outbox.service';

/**
 * Duyệt/từ chối request >48h + hết-hạn chờ-duyệt (FR-13, 3.4/3.5b). Optimistic-lock version,
 * đồng hồ 1 nguồn Postgres, audit lần-thua ngoài tx. cancelExpiredWithin PUBLIC — core
 * expireStaleHoldsForAsset gọi lại (expire-on-conflict submit). Tách khỏi TicketsService (mục 6).
 */
@Injectable()
export class TicketsApprovalService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
    private readonly outbox: OutboxService,
  ) {}

  /** Đọc ticket pending_approval trong tx + kiểm version/state chung cho approve+reject. */
  private async lockPendingForDecision(
    tx: Pick<Database, 'execute' | 'insert'>,
    ticketId: string,
    version: number,
  ): Promise<{ pickupPassed: boolean | null }> {
    const rows = await tx.execute<{
      state: string;
      version: number;
      kind: string;
      pickup_passed: boolean | null;
    }>(sql`
      SELECT t.state, t.version, t.kind,
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
    // Chuỗi định kỳ phải qua approveChain/rejectChain (deriveParentState — AD-4). Chặn duyệt
    // thẳng để không bỏ qua derive + ghi audit sai nhãn (đối xứng lockParent, audit 2026-07-16 H4).
    if (t.kind !== 'normal') {
      throw new ConflictException({
        code: 'INVALID_STATE',
        message: 'Request định kỳ phải được duyệt qua luồng chuỗi.',
      });
    }
    return { pickupPassed: t.pickup_passed };
  }

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
        // Báo người mượn yêu cầu bị từ chối, kèm lý do (bật/tắt ở Cấu hình thông báo).
        await this.outbox.enqueueWithin(tx, 'request_rejected', {
          ticketId,
          reason,
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

  async cancelExpiredWithin(
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
}
