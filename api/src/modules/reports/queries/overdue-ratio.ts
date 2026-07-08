import { sql } from 'drizzle-orm';
import type { Database } from '../../../database/database.module';

type Tx = Pick<Database, 'execute'>;

export interface MonthlyOverdueRow {
  month: string; // 'YYYY-MM' theo lịch VN
  total: number;
  overdue: number;
  ratio: number | null; // null khi total = 0 → FE hiển thị "—"
}

/**
 * AC3 (FR-42, AD-14) — tỉ lệ quá hạn theo tháng: tử = ticket close có `overdue_marked_at` (marker
 * bất biến, KHÔNG dùng cờ is_overdue), mẫu = tổng ticket close; CẢ hai loại `close_reason='no_show'`.
 * Ranh giới tháng cắt nửa đêm `Asia/Ho_Chi_Minh` (không UTC). Trả ĐỦ dãy tháng trong kỳ — tháng
 * không có ticket close → total=0, ratio=null ("—"), không chia cho 0.
 */
export async function overdueRatioByMonth(
  db: Tx,
  from: string,
  to: string,
): Promise<MonthlyOverdueRow[]> {
  const res = await db.execute<{
    month: string;
    total: number;
    overdue: number;
  }>(sql`
    WITH months AS (
      SELECT to_char(m, 'YYYY-MM') AS month
      FROM generate_series(
        date_trunc('month', ${from}::date),
        date_trunc('month', ${to}::date),
        interval '1 month'
      ) m
    ),
    closes AS (
      SELECT to_char(
               date_trunc('month', t.closed_at AT TIME ZONE 'Asia/Ho_Chi_Minh'),
               'YYYY-MM') AS month,
             count(*)::int AS total,
             count(*) FILTER (WHERE t.overdue_marked_at IS NOT NULL)::int AS overdue
      FROM ticket t
      WHERE t.state = 'closed'
        AND t.close_reason IS DISTINCT FROM 'no_show'
        AND t.closed_at IS NOT NULL
        AND (t.closed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1
    )
    SELECT m.month,
           COALESCE(c.total, 0) AS total,
           COALESCE(c.overdue, 0) AS overdue
    FROM months m LEFT JOIN closes c ON c.month = m.month
    ORDER BY m.month
  `);
  return res.rows.map((r) => ({
    month: r.month,
    total: r.total,
    overdue: r.overdue,
    ratio: r.total > 0 ? r.overdue / r.total : null,
  }));
}
