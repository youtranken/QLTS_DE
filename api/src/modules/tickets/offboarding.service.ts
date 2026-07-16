import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { OutboxService } from '../outbox/outbox.service';

export interface OffboardAlert {
  sub: string;
  fullName: string | null;
  status: string;
  ticketCount: number;
  assetCount: number;
}

export interface OffboardNeedsMatch {
  id: string;
  code: string;
  importedUserText: string | null;
}

const DISABLED = sql`('locked', 'deleted')`;
const ACTIVE_TICKET = sql`('pending_approval', 'awaiting_pickup', 'in_use')`;

/**
 * Tài sản user THỰC giữ (alias `a`): loại máy đã thanh lý/xóa vĩnh viễn — đồng bộ
 * me.service ("Máy của tôi"). Không lọc → offboarding báo phantom vĩnh viễn cho NV nghỉ
 * việc từng giữ máy nay đã disposed/purged (audit 2026-07-16 H1).
 */
const heldAssetWhere = (subExpr: ReturnType<typeof sql>) =>
  sql`a.assigned_user_sub = ${subExpr} AND a.status <> 'disposed' AND a.purged_at IS NULL`;

/**
 * Cảnh báo nghỉ việc + cascade offboarding (5.5, AD-1/AD-9). Tickets sở hữu state nên cascade
 * ở đây (không phá ranh giới module). Cảnh báo DERIVE từ `users.status` — active lại thì tự tắt;
 * marker `offboard_alerted_at` chỉ chống MAIL đúp (webhook ‖ polling cùng scan).
 */
@Injectable()
export class OffboardingService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly outbox: OutboxService,
    private readonly audit: AuditWriterService,
  ) {}

  /**
   * Sweep: (1) user active lại → reset marker (AC4 tự-tắt); (2) user disable còn ticket/asset
   * chưa cảnh báo → claim marker (chống đúp) + cascade + phát `offboard_alert`. Trả số user mới.
   */
  async runOffboardingScan(): Promise<number> {
    await this.db.execute(sql`
      UPDATE users SET offboard_alerted_at = NULL
      WHERE status = 'active' AND offboard_alerted_at IS NOT NULL
    `);

    const rows = await this.db.execute<{ sub: string }>(sql`
      SELECT u.sub FROM users u
      WHERE u.status IN ${DISABLED} AND u.offboard_alerted_at IS NULL
        AND (
          EXISTS (SELECT 1 FROM ticket t
                  WHERE t.borrower_sub = u.sub AND t.state IN ${ACTIVE_TICKET})
          OR EXISTS (SELECT 1 FROM assets a WHERE ${heldAssetWhere(sql`u.sub`)})
        )
    `);

    let n = 0;
    for (const { sub } of rows.rows) {
      const alerted = await this.db.transaction(async (tx) => {
        // Claim marker có điều kiện → 2 scan song song / webhook đồng thời không cảnh báo đúp.
        const claim = await tx.execute<{ sub: string }>(sql`
          UPDATE users SET offboard_alerted_at = now()
          WHERE sub = ${sub} AND status IN ${DISABLED} AND offboard_alerted_at IS NULL
          RETURNING sub
        `);
        if (claim.rows.length !== 1) return false;
        await this.cascadeForUser(tx, sub);
        // CHỈ cảnh báo khi SAU cascade còn thứ cần thu hồi: ticket đang mượn (in_use) HOẶC đứng
        // tên tài sản. pending/awaiting đã tự hủy sạch → không có gì để Admin thu → không mail
        // (M1: mail/queue/alert nhất quán, không báo "còn 0 ticket 0 tài sản").
        const rec = await tx.execute<{ r: boolean }>(sql`
          SELECT (
            EXISTS (SELECT 1 FROM ticket t WHERE t.borrower_sub = ${sub} AND t.state = 'in_use')
            OR EXISTS (SELECT 1 FROM assets a WHERE ${heldAssetWhere(sql`${sub}`)})
          ) AS r
        `);
        if (!rec.rows[0].r) return false;
        await this.outbox.enqueueWithin(tx, 'offboard_alert', { sub });
        return true;
      });
      if (alerted) n++;
    }
    return n;
  }

  /**
   * Hủy phần "chưa giao" của user disable, GIỮ ticket đang mượn (FR-4a — Admin thu hồi tay):
   * mọi booking `held`/`pending` (future/stale-pickup/extension) → cancelled (nhả khung); ticket
   * `pending_approval`/`awaiting_pickup` → cancelled (rời hàng đợi duyệt 3.12 + thoát mail nhắc 5.2).
   * `in_use` (booking `delivered`) không đụng.
   */
  private async cascadeForUser(
    tx: Pick<Database, 'execute' | 'insert'>,
    sub: string,
  ): Promise<void> {
    // Khóa ticket active của user (thứ tự id — chống deadlock với flow khóa 1-ticket khác).
    await tx.execute(sql`
      SELECT id FROM ticket WHERE borrower_sub = ${sub} AND state IN ${ACTIVE_TICKET}
      ORDER BY id FOR UPDATE
    `);
    await tx.execute(sql`
      UPDATE booking SET state = 'cancelled', version = version + 1, updated_at = now()
      WHERE ticket_id IN (
          SELECT id FROM ticket WHERE borrower_sub = ${sub} AND state IN ${ACTIVE_TICKET}
        )
        AND state IN ('held', 'pending')
    `);
    await tx.execute(sql`
      UPDATE ticket SET state = 'cancelled', version = version + 1, updated_at = now()
      WHERE borrower_sub = ${sub} AND state IN ('pending_approval', 'awaiting_pickup')
    `);
    await this.audit.appendWithin(tx, {
      actor: 'system',
      action: 'tickets.offboard_cascade',
      objectType: 'user',
      objectId: sub,
      detail: { reason: 'account_disabled' },
    });
  }

  /** Hàng đợi cảnh báo (AC3/AC4) + mục "cần đối chiếu" RIÊNG (AC5). Derive từ status hiện tại. */
  async listOffboardingQueue(): Promise<{
    total: number;
    alerts: OffboardAlert[];
    needsMatch: OffboardNeedsMatch[];
  }> {
    // "Cần thu hồi" = ticket đang mượn (in_use) HOẶC đứng tên tài sản — khớp điều kiện alert
    // (M1: mail/queue nhất quán). pending/awaiting đã tự hủy nên không nằm ở đây.
    const alerts = await this.db.execute<{
      sub: string;
      full_name: string | null;
      status: string;
      ticket_count: number;
      asset_count: number;
    }>(sql`
      SELECT u.sub, u.full_name, u.status,
        (SELECT count(*)::int FROM ticket t
         WHERE t.borrower_sub = u.sub AND t.state = 'in_use') AS ticket_count,
        (SELECT count(*)::int FROM assets a WHERE ${heldAssetWhere(sql`u.sub`)}) AS asset_count
      FROM users u
      WHERE u.status IN ${DISABLED}
        AND (
          EXISTS (SELECT 1 FROM ticket t WHERE t.borrower_sub = u.sub AND t.state = 'in_use')
          OR EXISTS (SELECT 1 FROM assets a WHERE ${heldAssetWhere(sql`u.sub`)})
        )
      ORDER BY u.full_name NULLS LAST
    `);
    const needs = await this.db.execute<{
      id: string;
      code: string;
      imported_user_text: string | null;
    }>(sql`
      SELECT id, code, imported_user_text FROM assets
      WHERE needs_user_match = true
      ORDER BY code
    `);
    return {
      total: alerts.rows.length,
      alerts: alerts.rows.map((r) => ({
        sub: r.sub,
        fullName: r.full_name,
        status: r.status,
        ticketCount: r.ticket_count,
        assetCount: r.asset_count,
      })),
      needsMatch: needs.rows.map((r) => ({
        id: r.id,
        code: r.code,
        importedUserText: r.imported_user_text,
      })),
    };
  }
}
