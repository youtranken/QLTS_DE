import { sql } from 'drizzle-orm';
import type { Database } from '../../../database/database.module';

type Tx = Pick<Database, 'execute'>;

export interface AssetBorrowRow {
  assetId: string;
  code: string;
  type: string;
  count: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * AC1 (FR-42) — lượt giao thành công theo máy: booking `kind ∈ {normal,recurring}` TỪNG delivered.
 * "Từng delivered" = state ∈ {delivered, returned} (vòng đời: chưa-giao kết thúc cancelled, đã-giao
 * kết thúc returned — AD-16). `extension` KHÔNG đếm. Mốc trong kỳ = `lower(period)` theo NGÀY VN.
 * total = số MÁY (distinct) để phân trang; máy 0 lượt không xuất hiện.
 */
export async function borrowByAsset(
  db: Tx,
  from: string,
  to: string,
  page: number,
  pageSize: number,
): Promise<Paged<AssetBorrowRow>> {
  const offset = (page - 1) * pageSize;
  const [items, totalRows] = await Promise.all([
    db.execute<{ asset_id: string; code: string; type: string; n: number }>(sql`
      SELECT b.asset_id, a.code, a.type, count(*)::int AS n
      FROM booking b JOIN assets a ON a.id = b.asset_id
      WHERE b.kind IN ('normal', 'recurring')
        AND b.state IN ('delivered', 'returned')
        AND (lower(b.period) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN ${from}::date AND ${to}::date
      GROUP BY b.asset_id, a.code, a.type
      ORDER BY n DESC, a.code
      LIMIT ${pageSize} OFFSET ${offset}
    `),
    db.execute<{ n: number }>(sql`
      SELECT count(DISTINCT b.asset_id)::int AS n
      FROM booking b
      WHERE b.kind IN ('normal', 'recurring')
        AND b.state IN ('delivered', 'returned')
        AND (lower(b.period) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
            BETWEEN ${from}::date AND ${to}::date
    `),
  ]);
  return {
    items: items.rows.map((r) => ({
      assetId: r.asset_id,
      code: r.code,
      type: r.type,
      count: r.n,
    })),
    total: totalRows.rows[0]?.n ?? 0,
    page,
    pageSize,
  };
}
