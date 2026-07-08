import { sql } from 'drizzle-orm';
import type { Database } from '../../../database/database.module';
import type { Paged } from './borrow-by-asset';

type Tx = Pick<Database, 'execute'>;

export interface UserBorrowRow {
  borrowerSub: string;
  fullName: string | null;
  count: number;
}

/**
 * AC2 (FR-42) — lượt mượn theo người: đếm TICKET close trong kỳ theo người mượn,
 * LOẠI `close_reason='no_show'` (chưa từng cầm máy không tính). Đếm theo ticket nên
 * chuỗi định kỳ đếm 1 (1 ticket cha). Bucket kỳ = `closed_at` theo NGÀY VN (marker 6.1).
 */
export async function borrowByUser(
  db: Tx,
  from: string,
  to: string,
  page: number,
  pageSize: number,
): Promise<Paged<UserBorrowRow>> {
  const offset = (page - 1) * pageSize;
  const [items, totalRows] = await Promise.all([
    db.execute<{
      borrower_sub: string;
      full_name: string | null;
      n: number;
    }>(sql`
      SELECT t.borrower_sub, u.full_name, count(*)::int AS n
      FROM ticket t LEFT JOIN users u ON u.sub = t.borrower_sub
      WHERE t.state = 'closed'
        AND t.close_reason IS DISTINCT FROM 'no_show'
        AND t.closed_at IS NOT NULL
        AND (t.closed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN ${from}::date AND ${to}::date
      GROUP BY t.borrower_sub, u.full_name
      -- tiebreak khóa DUY NHẤT (borrower_sub) → phân trang OFFSET ổn định khi trùng count/tên NULL
      ORDER BY n DESC, u.full_name, t.borrower_sub
      LIMIT ${pageSize} OFFSET ${offset}
    `),
    db.execute<{ n: number }>(sql`
      SELECT count(DISTINCT t.borrower_sub)::int AS n
      FROM ticket t
      WHERE t.state = 'closed'
        AND t.close_reason IS DISTINCT FROM 'no_show'
        AND t.closed_at IS NOT NULL
        AND (t.closed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN ${from}::date AND ${to}::date
    `),
  ]);
  return {
    items: items.rows.map((r) => ({
      borrowerSub: r.borrower_sub,
      fullName: r.full_name,
      count: r.n,
    })),
    total: totalRows.rows[0]?.n ?? 0,
    page,
    pageSize,
  };
}
