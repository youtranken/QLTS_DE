import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { SystemConfigService } from '../config/system-config.service';
import { mapAssetPgError } from './asset-pg-error';
import { assetsTable } from './assets.schema';

/**
 * Cụm phần mềm/license tách khỏi AssetsService (CLAUDE.md §6 — một trách nhiệm/file):
 * cảnh báo hết hạn, kiểm tra máy cài, liệt kê phần mềm của máy, chuyển license giữa máy.
 * AssetsService (giữ bất biến sổ tài sản, AD-4) phối hợp qua service công khai này.
 */
@Injectable()
export class AssetSoftwareService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
    private readonly config: SystemConfigService,
  ) {}

  /** Ngày cắt "sắp hết hạn" theo TZ VN + ngưỡng Config (7.7) — dùng cho list/export/count. */
  async expiringCutoff(): Promise<string> {
    const warningDays = await this.config.getLicenseWarningDays();
    const rows = await this.db.execute<{ d: string }>(
      sql`SELECT ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + ${warningDays}::int)::text AS d`,
    );
    return rows.rows[0].d;
  }

  /** Badge "Sắp hết hạn" (7.7, AC2) — gộp thiết bị + license term đang gắn; loại disposed. */
  async countExpiring(): Promise<number> {
    const before = await this.expiringCutoff();
    const rows = await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM assets
      WHERE status <> 'disposed'
        AND end_date IS NOT NULL
        AND end_date <= ${before}::date
        AND (type <> 'software'
             OR (license_type = 'term' AND installed_on_asset_id IS NOT NULL))
    `);
    return rows.rows[0]?.n ?? 0;
  }

  /**
   * Danh sách phần mềm GOM NHÓM theo tên license — 1 license mua nhiều bản (seat), mỗi bản
   * start/end + máy riêng nhưng chung tên. Đếm: tổng bản / đã gắn máy / còn dư / sắp hết hạn.
   * Loại bản đã thanh lý (không còn là bản đang sở hữu). `search` lọc theo tên license.
   */
  async listLicenseGroups(search?: string) {
    const before = await this.expiringCutoff();
    const pattern = search ? `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const rows = await this.db.execute<{
      licenseName: string;
      licenseType: string | null;
      total: number;
      assigned: number;
      free: number;
      expiring: number;
      nextExpiry: string | null;
      holders: number;
    }>(sql`
      SELECT s.license_name AS "licenseName",
             min(s.license_type) AS "licenseType",
             count(*)::int AS total,
             count(*) FILTER (WHERE s.installed_on_asset_id IS NOT NULL)::int AS assigned,
             count(*) FILTER (WHERE s.installed_on_asset_id IS NULL)::int AS free,
             count(*) FILTER (
               WHERE s.license_type = 'term' AND s.end_date IS NOT NULL AND s.end_date <= ${before}::date
             )::int AS expiring,
             min(s.end_date) FILTER (WHERE s.license_type = 'term')::text AS "nextExpiry",
             -- Người giữ = chủ máy đang cài (holder derive theo máy); NULL (ghế trống) bị count distinct bỏ qua
             count(DISTINCT host.assigned_user_sub)::int AS holders
      FROM assets s
      LEFT JOIN assets host ON host.id = s.installed_on_asset_id
      WHERE s.type = 'software' AND s.status <> 'disposed' AND s.license_name IS NOT NULL
        ${pattern ? sql`AND s.license_name ILIKE ${pattern}` : sql``}
      GROUP BY s.license_name
      ORDER BY s.license_name
    `);
    return rows.rows;
  }

  /** Software đang cài trên một máy (2.4, AC 2) — 2.7 và Epic 3 dùng lại.
   *  Định danh bằng license_name (sw-license-model-redesign); người đứng tên = của máy này. */
  async listInstalledSoftware(assetId: string) {
    return this.db
      .select({
        id: assetsTable.id,
        code: assetsTable.code,
        licenseType: assetsTable.licenseType,
        licenseName: assetsTable.licenseName,
        startDate: assetsTable.startDate,
        endDate: assetsTable.endDate,
        brand: assetsTable.brand,
        status: assetsTable.status,
      })
      .from(assetsTable)
      .where(eq(assetsTable.installedOnAssetId, assetId))
      .orderBy(assetsTable.licenseName);
  }

  /** Kiểm máy đích để cài phần mềm (2.4) — FOR UPDATE giữ target đến hết tx (chống race dispose). */
  async assertInstallTarget(
    tx: Pick<Database, 'select'>,
    targetId: string,
  ): Promise<void> {
    const rows = await tx
      .select({ type: assetsTable.type, status: assetsTable.status })
      .from(assetsTable)
      .where(eq(assetsTable.id, targetId))
      .for('update');
    if (rows.length === 0) {
      throw new BadRequestException({
        code: 'INSTALL_TARGET_NOT_FOUND',
        message: 'Máy để cài phần mềm không tồn tại.',
      });
    }
    if (rows[0].type === 'software') {
      throw new BadRequestException({
        code: 'INSTALL_ON_SOFTWARE',
        message: 'Phần mềm chỉ cài được trên máy, không cài lên phần mềm khác.',
      });
    }
    if (rows[0].status === 'disposed') {
      throw new ConflictException({
        code: 'INSTALL_TARGET_DISPOSED',
        message: 'Máy đã thanh lý — không gắn phần mềm vào được.',
      });
    }
  }

  /**
   * Chuyển license giữa máy hoặc gỡ về "chưa gắn máy" (2.5, FR-50) — endpoint RIÊNG,
   * không đi qua PUT sửa (AC 3 của 2.4). Optimistic lock như update.
   */
  async transferLicense(
    id: string,
    targetAssetId: string | null,
    version: number,
    actorSub: string,
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        if (targetAssetId) {
          await this.assertInstallTarget(tx, targetAssetId);
        }
        const result = await tx.execute<Record<string, unknown>>(sql`
          UPDATE assets AS a
          SET installed_on_asset_id = ${targetAssetId},
              version = a.version + 1,
              updated_at = now()
          FROM (SELECT * FROM assets WHERE id = ${id} FOR UPDATE) AS old
          WHERE a.id = old.id AND old.version = ${version}
            AND old.type = 'software' AND old.status <> 'disposed'
          RETURNING a.version AS new_version,
            old.installed_on_asset_id::text AS old_target
        `);
        const row = result.rows[0];
        if (!row) {
          const existing = await tx
            .select({ type: assetsTable.type, status: assetsTable.status })
            .from(assetsTable)
            .where(eq(assetsTable.id, id));
          if (existing.length === 0) {
            throw new NotFoundException({
              code: 'ASSET_NOT_FOUND',
              message: 'Không tìm thấy tài sản này.',
            });
          }
          if (existing[0].type !== 'software') {
            throw new BadRequestException({
              code: 'NOT_SOFTWARE',
              message: 'Chỉ phần mềm mới chuyển được giữa máy.',
            });
          }
          // TERMINAL (review 2.6): software thanh lý không được "hồi sinh" qua transfer
          if (existing[0].status === 'disposed') {
            throw new ConflictException({
              code: 'INVALID_STATE',
              message: 'Phần mềm đã thanh lý — không chuyển được nữa.',
            });
          }
          throw new ConflictException({
            code: 'STALE_VERSION',
            message: 'Trạng thái đã thay đổi, tải lại.',
          });
        }
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'assets.license_transfer',
          objectType: 'asset',
          objectId: id,
          detail: {
            from: row.old_target ?? null,
            to: targetAssetId,
          },
        });
        return { ok: true, version: row.new_version as number };
      });
    } catch (error) {
      throw mapAssetPgError(error);
    }
  }
}
