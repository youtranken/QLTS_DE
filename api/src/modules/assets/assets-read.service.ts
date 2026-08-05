import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { SystemConfigService } from '../config/system-config.service';
import { usersTable } from '../users/users.schema';
import { allocationHistoryTable } from './allocation-history.schema';
import { assetNoteTable } from './asset-note.schema';
import { assetsTable } from './assets.schema';
import { AssetSoftwareService } from './asset-software.service';
import { buildAssetListConditions } from './assets-query';
import type { AssetListQuery } from './assets.service';

/**
 * Read-model tài sản: list (tìm 1 ô + filter + sort server-side), getById, filterMeta,
 * listAllocations (lịch sử cấp phát), listNotes. CHỈ ĐỌC — tách khỏi AssetsService (mục 6).
 */
@Injectable()
export class AssetsReadService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly config: SystemConfigService,
    private readonly software: AssetSoftwareService,
  ) {}

  async list(query: AssetListQuery) {
    // FR-44: mốc cảnh báo đọc từ Config (AD-1) — SA chỉnh ở 6.3, hiệu lực ≤30s (TTL).
    // SystemConfigService.getInt đã validate int ≥ 0 tại nguồn (epic review) —
    // không cần fallback ở đây (||30 sẽ nuốt mất giá trị 0 = tắt cảnh báo).
    const warningDays = await this.config.getLicenseWarningDays();
    const host = alias(assetsTable, 'host');
    // Người đứng tên phần mềm = holder của MÁY nó gắn (sw-license-model-redesign) → user của host.
    const hostUser = alias(usersTable, 'host_user');
    // Truyền hostUser.fullName → tìm phần mềm theo người ĐANG GIỮ MÁY (holder derive).
    const where = buildAssetListConditions(
      query,
      query.expiring ? await this.software.expiringCutoff() : null,
      hostUser.fullName,
    );
    // Người đứng tên hiển thị của phần mềm = holder của máy → sort assignee cũng theo derive.
    const assigneeExpr = sql`CASE WHEN ${assetsTable.type} = 'software' THEN ${hostUser.fullName} ELSE ${usersTable.fullName} END`;
    // Sắp xếp server-side: cột đã whitelist ở DTO; id làm tiebreaker → phân trang ổn định.
    const sortCol =
      query.sort === 'type'
        ? assetsTable.type
        : query.sort === 'status'
          ? assetsTable.status
          : query.sort === 'assignee'
            ? assigneeExpr
            : assetsTable.code;
    const orderExpr = query.dir === 'desc' ? desc(sortCol) : sortCol;
    const [items, totalRows] = await Promise.all([
      this.db
        .select({
          id: assetsTable.id,
          code: assetsTable.code,
          type: assetsTable.type,
          status: assetsTable.status,
          isPool: assetsTable.isPool,
          // Thông số hiển thị ở bảng /tai-san (đại tu UAT): cấu hình/giá/ngày dùng/vị trí/hãng.
          configuration: assetsTable.configuration,
          cost: assetsTable.cost,
          startDate: assetsTable.startDate,
          floor: assetsTable.floor,
          brand: assetsTable.brand,
          // Ghi chú: cột "Ghi chú" ở chi tiết license (/phan-mem) — hiển thị rút gọn + title.
          note: assetsTable.note,
          contract: assetsTable.contract,
          // Máy tính license_name (định danh phần mềm thay mã) + host để tab Phần mềm hiển thị
          licenseName: assetsTable.licenseName,
          licenseType: assetsTable.licenseType,
          installedOnAssetId: assetsTable.installedOnAssetId,
          installedOnCode: host.code,
          endDate: assetsTable.endDate,
          // AC5: cột "Phần mềm" ở /tai-san — tên license đang cài trên MÁY này (gọn, inline).
          // Subquery scalar/dòng, chỉ chạy trên trang (≤pageSize) nên không nặng.
          installedSoftware: sql<string | null>`(
            SELECT string_agg(sw.license_name, ', ' ORDER BY sw.license_name)
            FROM assets sw
            WHERE sw.installed_on_asset_id = ${assetsTable.id}
              AND sw.type = 'software'
              AND sw.status <> 'disposed'
              AND sw.purged_at IS NULL
              AND sw.license_name IS NOT NULL
          )`,
          // Người đứng tên: phần mềm DERIVE từ host (đi theo máy); máy thì của chính nó.
          assignedUserSub: sql<
            string | null
          >`CASE WHEN ${assetsTable.type} = 'software' THEN ${host.assignedUserSub} ELSE ${assetsTable.assignedUserSub} END`,
          assignedUserName: sql<
            string | null
          >`CASE WHEN ${assetsTable.type} = 'software' THEN ${hostUser.fullName} ELSE ${usersTable.fullName} END`,
          // Mã nhân viên + Phòng ban theo người giữ (claim IDP) — phần mềm derive từ host.
          employeeCode: sql<
            string | null
          >`CASE WHEN ${assetsTable.type} = 'software' THEN ${hostUser.employeeCode} ELSE ${usersTable.employeeCode} END`,
          department: sql<
            string | null
          >`CASE WHEN ${assetsTable.type} = 'software' THEN ${hostUser.department} ELSE ${usersTable.department} END`,
          // Đỏ (2.5, FR-38): term + đang gắn máy KHÔNG thanh lý + hạn ≤ hôm nay+N
          // (bao gồm đã quá hạn); computed mỗi query → đổi hạn là hết đỏ ngay (FR-29)
          // ĐỒNG BỘ TAY với common/license-expiry.ts (digest 5.6) — style query khác (drizzle
          // builder vs raw sql) nên không share trực tiếp; sửa điều kiện phải sửa CẢ HAI.
          // "hôm nay" theo TZ nghiệp vụ VN (convention từ working_hours 0001) —
          // CURRENT_DATE của pg là UTC, đỏ trễ tối đa 7h lúc 00:00-07:00 VN (review 2.5)
          licenseWarning: sql<boolean>`COALESCE((
            ${assetsTable.type} = 'software'
            AND ${assetsTable.status} <> 'disposed'
            AND ${assetsTable.licenseType} = 'term'
            AND ${assetsTable.installedOnAssetId} IS NOT NULL
            AND ${host.status} <> 'disposed'
            AND ${assetsTable.endDate} <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + ${warningDays}::int
          ), false)`,
        })
        .from(assetsTable)
        .leftJoin(usersTable, eq(assetsTable.assignedUserSub, usersTable.sub))
        .leftJoin(host, eq(assetsTable.installedOnAssetId, host.id))
        .leftJoin(hostUser, eq(host.assignedUserSub, hostUser.sub))
        .where(where)
        .orderBy(orderExpr, assetsTable.id)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(assetsTable)
        .leftJoin(usersTable, eq(assetsTable.assignedUserSub, usersTable.sub))
        // CÙNG join host/host_user như query items — where có thể lọc theo hostUser.fullName.
        .leftJoin(host, eq(assetsTable.installedOnAssetId, host.id))
        .leftJoin(hostUser, eq(host.assignedUserSub, hostUser.sub))
        .where(where),
    ]);
    return {
      items,
      total: totalRows[0]?.n ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async listAllocations(assetId: string) {
    const fromU = alias(usersTable, 'from_u');
    const toU = alias(usersTable, 'to_u');
    const actorU = alias(usersTable, 'actor_u');
    return this.db
      .select({
        id: allocationHistoryTable.id,
        fromUserSub: allocationHistoryTable.fromUserSub,
        fromUserName: fromU.fullName,
        toUserSub: allocationHistoryTable.toUserSub,
        toUserName: toU.fullName,
        note: allocationHistoryTable.note,
        actor: allocationHistoryTable.actor,
        actorName: actorU.fullName,
        createdAt: allocationHistoryTable.createdAt,
      })
      .from(allocationHistoryTable)
      .leftJoin(fromU, eq(allocationHistoryTable.fromUserSub, fromU.sub))
      .leftJoin(toU, eq(allocationHistoryTable.toUserSub, toU.sub))
      .leftJoin(actorU, eq(allocationHistoryTable.actor, actorU.sub))
      .where(eq(allocationHistoryTable.assetId, assetId))
      .orderBy(desc(allocationHistoryTable.createdAt))
      .limit(200);
  }

  /** Note tình trạng máy (2.7, FR-34) — lý do khóa/ETA (2.6) + giao-nhận (Epic 3), desc. */
  async listNotes(assetId: string) {
    const actorU = alias(usersTable, 'actor_u');
    return this.db
      .select({
        id: assetNoteTable.id,
        kind: assetNoteTable.kind,
        note: assetNoteTable.note,
        eta: assetNoteTable.eta,
        actor: assetNoteTable.actor,
        actorName: actorU.fullName,
        createdAt: assetNoteTable.createdAt,
      })
      .from(assetNoteTable)
      .leftJoin(actorU, eq(assetNoteTable.actor, actorU.sub))
      .where(eq(assetNoteTable.assetId, assetId))
      .orderBy(desc(assetNoteTable.createdAt))
      .limit(200);
  }

  /** Giá trị distinct cho dropdown lọc (story 2.2) — loại đang có trong sổ (Tầng gỡ ở 7.6). */
  async filterMeta() {
    const types = await this.db
      .selectDistinct({ v: assetsTable.type })
      .from(assetsTable)
      .orderBy(assetsTable.type);
    return {
      types: types.map((r) => r.v),
    };
  }

  async getById(id: string) {
    const host = alias(assetsTable, 'host');
    // Người đứng tên phần mềm DERIVE từ máy gắn (sw-license-model-redesign).
    const hostUser = alias(usersTable, 'host_user');
    const rows = await this.db
      .select({
        id: assetsTable.id,
        code: assetsTable.code,
        type: assetsTable.type,
        configuration: assetsTable.configuration,
        cost: assetsTable.cost,
        startDate: assetsTable.startDate,
        endDate: assetsTable.endDate,
        floor: assetsTable.floor,
        status: assetsTable.status,
        note: assetsTable.note,
        contract: assetsTable.contract,
        serial: assetsTable.serial,
        brand: assetsTable.brand,
        assignedUserSub: sql<
          string | null
        >`CASE WHEN ${assetsTable.type} = 'software' THEN ${host.assignedUserSub} ELSE ${assetsTable.assignedUserSub} END`,
        assignedUserName: sql<
          string | null
        >`CASE WHEN ${assetsTable.type} = 'software' THEN ${hostUser.fullName} ELSE ${usersTable.fullName} END`,
        department: sql<
          string | null
        >`CASE WHEN ${assetsTable.type} = 'software' THEN ${hostUser.department} ELSE ${usersTable.department} END`,
        licenseType: assetsTable.licenseType,
        licenseName: assetsTable.licenseName,
        installedOnAssetId: assetsTable.installedOnAssetId,
        installedOnCode: host.code,
        isPool: assetsTable.isPool,
        version: assetsTable.version,
      })
      .from(assetsTable)
      .leftJoin(usersTable, eq(assetsTable.assignedUserSub, usersTable.sub))
      .leftJoin(host, eq(assetsTable.installedOnAssetId, host.id))
      .leftJoin(hostUser, eq(host.assignedUserSub, hostUser.sub))
      .where(eq(assetsTable.id, id));
    if (!rows[0]) {
      throw new NotFoundException({
        code: 'ASSET_NOT_FOUND',
        message: 'Không tìm thấy tài sản này.',
      });
    }
    return rows[0];
  }
}
