import { sql, type SQL } from 'drizzle-orm';

/**
 * Điều kiện license "sắp/đã hết hạn" (FR-38) — ĐỒNG BỘ với dòng đỏ 2.5 (`assets.service.ts` list):
 * license có thời hạn (`term`), đang gắn máy KHÔNG thanh lý, hạn ≤ hôm-nay-VN + warningDays.
 * Dùng với `FROM assets a LEFT JOIN assets h ON h.id = a.installed_on_asset_id`.
 * "Hôm nay" theo TZ nghiệp vụ VN (không dùng CURRENT_DATE UTC).
 * ĐỒNG BỘ TAY với dòng đỏ 2.5 (`assets.service.ts` list, ~dòng 324) — sửa điều kiện phải sửa CẢ HAI.
 */
export function expiringLicenseWhere(warningDays: number): SQL {
  return sql`
    a.type = 'software'
    AND a.status <> 'disposed'
    AND a.license_type = 'term'
    AND a.installed_on_asset_id IS NOT NULL
    AND h.status <> 'disposed'
    AND a.end_date <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + ${warningDays}::int
  `;
}
