import { sql } from 'drizzle-orm';
import type { Database } from '../../database/database.module';

type Tx = Pick<Database, 'execute'>;

/**
 * Suy state ticket cha định kỳ từ các buổi (STORED, AD-4) + rollup cờ quá hạn — MỘT nguồn
 * duy nhất (party phiên 7). Caller PHẢI đã `SELECT ... FOR UPDATE` hàng ticket cha TRONG CÙNG
 * transaction trước khi gọi → 2 transition đồng thời trên 2 buổi khác nhau serialize tại cha
 * (không "cha treo xác sống, quota không nhả").
 *
 * Bảng chân trị: còn held→pending_approval; có delivered→in_use; còn pending→awaiting_pickup;
 * mọi buổi terminal & ≥1 returned→closed; else cancelled. is_overdue = còn buổi delivered quá hạn;
 * overdue_marked_at ghi MỘT LẦN (COALESCE) để báo cáo 6.1 "từng quá hạn" không sót.
 */
export async function deriveParentState(
  tx: Tx,
  ticketId: string,
): Promise<void> {
  const r = await tx.execute<{
    held: number;
    pending: number;
    delivered: number;
    returned: number;
    any_overdue: boolean;
  }>(sql`
    SELECT
      count(*) FILTER (WHERE state = 'held')::int AS held,
      count(*) FILTER (WHERE state = 'pending')::int AS pending,
      count(*) FILTER (WHERE state = 'delivered')::int AS delivered,
      count(*) FILTER (WHERE state = 'returned')::int AS returned,
      COALESCE(bool_or(state = 'delivered' AND upper(period) < now()), false)
        AS any_overdue
    FROM booking WHERE ticket_id = ${ticketId} AND kind = 'recurring'
  `);
  const c = r.rows[0];
  let state: string;
  if (c.held > 0) state = 'pending_approval';
  else if (c.delivered > 0) state = 'in_use';
  else if (c.pending > 0) state = 'awaiting_pickup';
  else if (c.returned > 0) state = 'closed';
  else state = 'cancelled';
  await tx.execute(sql`
    UPDATE ticket SET state = ${state}, is_overdue = ${c.any_overdue},
      overdue_marked_at = COALESCE(overdue_marked_at,
        CASE WHEN ${c.any_overdue} THEN now() END),
      closed_at = COALESCE(closed_at,
        CASE WHEN ${state} = 'closed' THEN now() END),
      version = version + 1, updated_at = now()
    WHERE id = ${ticketId}
  `);
}
