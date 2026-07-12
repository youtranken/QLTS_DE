import { and, eq, ilike, or, sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import { usersTable } from '../users/users.schema';
import { assetsTable } from './assets.schema';
import { escapeLike } from '../../common/sql';

/** Bộ lọc tìm/loại/trạng thái/sắp-hết-hạn dùng CHUNG cho list (2.2) + count + export (2.10).
 * MỘT nguồn sự thật — tách ra pure function (§6) để list và cụm export dùng lại, không lệch.
 * `expiringBefore` = ngày cắt (VN) cho lọc "sắp hết hạn" (7.7); caller tính từ warningDays.
 * `hostHolderName` (tuỳ chọn) = cột tên người giữ MÁY (host_user.fullName): khi truyền, tìm
 * kiếm khớp thêm người-đứng-tên-derive của phần mềm (sw-license-model-redesign) — caller phải
 * đã JOIN host + host_user để cột này resolve được. */
export function buildAssetListConditions(
  query: {
    search?: string;
    type?: string;
    status?: string;
    expiring?: boolean;
  },
  expiringBefore: string | null = null,
  hostHolderName?: AnyColumn | SQL,
): SQL | undefined {
  const pat = query.search ? `%${escapeLike(query.search)}%` : null;
  const conditions = [
    pat
      ? or(
          ilike(assetsTable.code, pat),
          ilike(usersTable.fullName, pat),
          // 7.7: tìm theo software — license_name của chính software + software gắn máy
          ilike(assetsTable.licenseName, pat),
          // sw-license-model follow-up: tìm phần mềm theo người ĐANG GIỮ MÁY (holder derive)
          hostHolderName ? ilike(hostHolderName, pat) : undefined,
          sql`EXISTS (SELECT 1 FROM assets sw
            WHERE sw.installed_on_asset_id = ${assetsTable.id}
              AND sw.type = 'software'
              AND (sw.code ILIKE ${pat} OR sw.license_name ILIKE ${pat}))`,
        )
      : undefined,
    query.type ? eq(assetsTable.type, query.type) : undefined,
    query.status ? eq(assetsTable.status, query.status) : undefined,
    // 7.7 "sắp hết hạn": thiết bị bất kỳ có endDate, HOẶC license term đang gắn máy
    // (installed IS NOT NULL ⇒ host chưa thanh lý — máy disposed tự detach license 2.5).
    query.expiring && expiringBefore
      ? sql`${assetsTable.status} <> 'disposed'
          AND ${assetsTable.endDate} IS NOT NULL
          AND ${assetsTable.endDate} <= ${expiringBefore}::date
          AND (${assetsTable.type} <> 'software'
               OR (${assetsTable.licenseType} = 'term'
                   AND ${assetsTable.installedOnAssetId} IS NOT NULL))`
      : undefined,
  ].filter((c) => c !== undefined);
  return conditions.length > 0 ? and(...conditions) : undefined;
}
