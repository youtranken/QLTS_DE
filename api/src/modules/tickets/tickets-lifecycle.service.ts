import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { mapBookingPgError } from '../../common/booking-errors';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { OutboxService } from '../outbox/outbox.service';
import { AssetsService } from '../assets/assets.service';

/**
 * Vòng đời máy cascade (3.10, AD-1 Tickets→Assets): mở tx, gọi AssetsService đổi trạng thái
 * máy (lock/unlock/dispose/setPool) rồi cascade hủy booking tương lai TRONG CÙNG transaction.
 * Tách khỏi TicketsService (mục 6 granularity) — logic tự chứa, chỉ chia sẻ qua facade.
 */
@Injectable()
export class TicketsLifecycleService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
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
    // ETA phải SAU hôm nay (VN): auto-unlock chạy mỗi 60s, ETA ≤ hôm nay sẽ mở lại tức thì.
    if (eta) {
      const todayVn = new Date().toLocaleDateString('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
      });
      if (eta <= todayVn) {
        throw new BadRequestException({
          code: 'LOCK_ETA_PAST',
          message: 'Ngày dự kiến xong phải sau hôm nay.',
        });
      }
    }
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
          detail: {
            reason: 'asset_unbookable',
            bookingId: b.id,
            notified: notify,
          },
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
}
