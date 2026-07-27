import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { ExtensionService } from './extension.service';
import { OCCUPYING_STATES } from './ticket-states';

/**
 * Giao/nhận máy (FR-14/17, 3.6): deliver awaiting_pickup→in_use, returnTicket in_use→closed
 * (nhả gia hạn treo). attachHandoverArtifacts PUBLIC — core createForMember (giao ngay) gọi lại.
 * Tách khỏi TicketsService (mục 6); delegate giữ public API cho controller.
 */
@Injectable()
export class TicketsHandoverService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
    private readonly extension: ExtensionService,
  ) {}

  /** Gắn ảnh (đã upload qua /admin/files) vào ticket theo phase + ghi note handover. */
  async attachHandoverArtifacts(
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
}
