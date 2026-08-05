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
import { allocationHistoryTable } from './allocation-history.schema';
import { assetsTable } from './assets.schema';
import { mapAssetPgError } from './asset-pg-error';
import { AssetSoftwareService } from './asset-software.service';
import {
  normalizeSoftwareInput,
  validateSoftwareInput,
} from './software-license';
import type { AssetInput } from './assets.service';

// 7.6 gỡ model/floor khỏi form; UAT sau đó hồi sinh 'floor' (Place) — 'model' vẫn gỡ.
const EDITABLE_FIELDS = [
  'code',
  'type',
  'configuration',
  'cost',
  'start_date',
  'end_date',
  'floor',
  'note',
  'contract',
  'serial',
  'brand',
  'assigned_user_sub',
  'license_type',
  'license_name',
] as const;

/**
 * Write-path sổ tài sản (FR-30/35/49): create, update (optimistic-lock), deleteAsset
 * (hard-delete máy sạch), purgeDisposedAsset (soft-purge), assignOwner (đổi người đứng tên)
 * + ensureTypeInCatalog (chốt type ∈ danh mục). Tách khỏi AssetsService (mục 6).
 */
@Injectable()
export class AssetsWriteService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
    private readonly software: AssetSoftwareService,
  ) {}

  private async ensureTypeInCatalog(
    tx: Pick<Database, 'execute'>,
    type: string,
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO catalog (kind, value) VALUES ('type', ${type})
      ON CONFLICT (kind, value) DO NOTHING
    `);
  }

  async create(
    input: AssetInput,
    actorSub: string,
    /** Chỉ set khi TẠO (2.4, AC 3) — đổi/gỡ là thao tác "chuyển" ở 2.5. */
    installedOnAssetId: string | null = null,
  ) {
    validateSoftwareInput(input);
    input = normalizeSoftwareInput(input); // chốt: software không mã/cấu hình/người đứng tên
    if (installedOnAssetId && input.type !== 'software') {
      throw new BadRequestException({
        code: 'SOFTWARE_FIELDS_ONLY',
        message: 'Chỉ phần mềm mới gắn được vào máy.',
      });
    }
    try {
      return await this.db.transaction(async (tx) => {
        if (installedOnAssetId) {
          await this.software.assertInstallTarget(tx, installedOnAssetId);
        }
        // A1 (UAT 2026-07-12): loại thiết bị phải thuộc danh mục Loại — chặn tạo "type mồ côi".
        if (input.type !== 'software') {
          await this.ensureTypeInCatalog(tx, input.type);
        }
        const rows = await tx
          .insert(assetsTable)
          .values({
            code: input.code,
            type: input.type,
            configuration: input.configuration,
            cost: input.cost,
            startDate: input.startDate,
            endDate: input.endDate,
            floor: input.floor,
            note: input.note,
            contract: input.contract,
            serial: input.serial,
            brand: input.brand,
            // đã normalize: software → null (derive từ máy); máy → holder thật
            assignedUserSub: input.assignedUserSub,
            licenseType: input.licenseType,
            licenseName: input.licenseName,
            installedOnAssetId,
          })
          .returning();
        const asset = rows[0];
        // tạo mới CÓ người đứng tên → seed bản ghi cấp phát đầu tiên (2.3, AC 1)
        if (asset.assignedUserSub) {
          await tx.insert(allocationHistoryTable).values({
            assetId: asset.id,
            fromUserSub: null,
            toUserSub: asset.assignedUserSub,
            note: null,
            actor: actorSub,
          });
        }
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'assets.create',
          objectType: 'asset',
          objectId: asset.id,
          detail: {
            code: asset.code,
            type: asset.type,
            assignedUserSub: asset.assignedUserSub,
            // create là điểm DUY NHẤT set installed_on (2.5 mới có "chuyển") — phải có vết
            installedOnAssetId: asset.installedOnAssetId,
            licenseType: asset.licenseType,
          },
        });
        return asset;
      });
    } catch (error) {
      throw mapAssetPgError(error);
    }
  }

  async update(
    id: string,
    input: AssetInput,
    version: number,
    actorSub: string,
    /** Ghi chú cấp phát — chỉ dùng khi assigned_user_sub ĐỔI (2.3). */
    allocationNote: string | null = null,
  ) {
    validateSoftwareInput(input);
    input = normalizeSoftwareInput(input); // chốt: software không mã/cấu hình/người đứng tên
    try {
      // Mutation + audit MỘT transaction (review 2.1) — mất vết = rollback cả sửa
      return await this.db.transaction(async (tx) => {
        // Software-ness bất biến (2.4, AC 3): đổi type qua/lại 'software' làm bản ghi
        // đổi bản chất (license/installed_on mồ côi) — chặn hẳn. SELECT không cần
        // lock: chính invariant này bảo đảm software-ness không đổi dưới chân ta.
        const current = await tx
          .select({ type: assetsTable.type })
          .from(assetsTable)
          .where(eq(assetsTable.id, id));
        if (
          current.length > 0 &&
          (current[0].type === 'software') !== (input.type === 'software')
        ) {
          throw new BadRequestException({
            code: 'TYPE_SOFTWARE_IMMUTABLE',
            message:
              'Không thể đổi bản ghi giữa thiết bị và phần mềm — tạo bản ghi mới.',
          });
        }
        // A1: loại thiết bị phải thuộc danh mục Loại (chặn sửa sang "type mồ côi").
        if (input.type !== 'software') {
          await this.ensureTypeInCatalog(tx, input.type);
        }
        const result = await tx.execute<Record<string, unknown>>(sql`
          UPDATE assets AS a
          SET code = ${input.code},
              type = ${input.type},
              configuration = ${input.configuration},
              cost = ${input.cost},
              start_date = ${input.startDate},
              end_date = ${input.endDate},
              floor = ${input.floor},
              note = ${input.note},
              contract = ${input.contract},
              serial = ${input.serial},
              brand = ${input.brand},
              assigned_user_sub = ${input.assignedUserSub},
              license_type = ${input.licenseType},
              license_name = ${input.licenseName},
              version = a.version + 1,
              updated_at = now()
          FROM (SELECT * FROM assets WHERE id = ${id} FOR UPDATE) AS old
          WHERE a.id = old.id AND old.version = ${version}
            AND old.status <> 'disposed'
          RETURNING a.version AS new_version,
            ${sql.raw(
              // ::text để so diff không lệ thuộc parser pg (date→Date local-time, bigint→string)
              EDITABLE_FIELDS.map((f) => `old.${f}::text AS old_${f}`).join(
                ', ',
              ),
            )}
        `);
        const row = result.rows[0];
        if (!row) {
          const exists = await tx
            .select({ id: assetsTable.id, status: assetsTable.status })
            .from(assetsTable)
            .where(eq(assetsTable.id, id));
          if (exists.length === 0) {
            throw new NotFoundException({
              code: 'ASSET_NOT_FOUND',
              message: 'Không tìm thấy tài sản này.',
            });
          }
          // TERMINAL kín mọi đường ghi (epic review F2): thanh lý = hồ sơ đã chốt,
          // PUT không được viết lại (kể cả người đứng tên — history append-only)
          if (exists[0].status === 'disposed') {
            throw new ConflictException({
              code: 'DISPOSED_TERMINAL',
              message: 'Tài sản đã thanh lý — hồ sơ đã chốt, không sửa được.',
            });
          }
          throw new ConflictException({
            code: 'STALE_VERSION',
            message: 'Trạng thái đã thay đổi, tải lại.',
          });
        }
        const changed = diffChanged(row, input);
        // đổi người đứng tên (kể cả thu hồi → NULL) → bản ghi cấp phát A→B (2.3, AC 1).
        // Phần mềm KHÔNG có lịch sử cấp phát riêng (holder derive từ máy) — chỉ máy mới ghi.
        if (input.type !== 'software' && 'assigned_user_sub' in changed) {
          await tx.insert(allocationHistoryTable).values({
            assetId: id,
            fromUserSub: (row.old_assigned_user_sub as string | null) ?? null,
            toUserSub: input.assignedUserSub,
            note: allocationNote,
            actor: actorSub,
          });
        }
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'assets.update',
          objectType: 'asset',
          objectId: id,
          detail: { changed },
        });
        return { ok: true, version: row.new_version as number };
      });
    } catch (error) {
      throw mapAssetPgError(error);
    }
  }

  async deleteAsset(id: string, version: number, actorSub: string) {
    try {
      return await this.db.transaction(async (tx) => {
        const current = await tx
          .select({
            id: assetsTable.id,
            version: assetsTable.version,
            isPool: assetsTable.isPool,
          })
          .from(assetsTable)
          .where(eq(assetsTable.id, id))
          .for('update');
        if (current.length === 0) {
          throw new NotFoundException({
            code: 'ASSET_NOT_FOUND',
            message: 'Không tìm thấy tài sản này.',
          });
        }
        if (current[0].version !== version) {
          throw new ConflictException({
            code: 'STALE_VERSION',
            message: 'Trạng thái đã thay đổi, tải lại.',
          });
        }
        if (current[0].isPool) {
          throw new ConflictException({
            code: 'ASSET_IN_POOL',
            message:
              'Máy đang ở pool cho mượn — gỡ khỏi pool trước, hoặc dùng Thanh lý.',
          });
        }
        // "Sạch" = chưa phát sinh gì. Thứ tự: booking → software cài → lịch sử.
        const exists = async (query: ReturnType<typeof sql>) =>
          (await tx.execute<{ one: number }>(query)).rows.length > 0;
        if (
          await exists(
            sql`SELECT 1 FROM booking WHERE asset_id = ${id} LIMIT 1`,
          )
        ) {
          throw new ConflictException({
            code: 'ASSET_HAS_BOOKING',
            message: 'Máy đã có lịch mượn — không xóa được, hãy dùng Thanh lý.',
          });
        }
        if (
          await exists(
            sql`SELECT 1 FROM assets WHERE installed_on_asset_id = ${id} LIMIT 1`,
          )
        ) {
          throw new ConflictException({
            code: 'ASSET_HAS_SOFTWARE',
            message: 'Máy còn phần mềm đang cài — gỡ phần mềm trước khi xóa.',
          });
        }
        if (
          (await exists(
            sql`SELECT 1 FROM allocation_history WHERE asset_id = ${id} LIMIT 1`,
          )) ||
          (await exists(
            sql`SELECT 1 FROM asset_note WHERE asset_id = ${id} LIMIT 1`,
          ))
        ) {
          throw new ConflictException({
            code: 'ASSET_HAS_HISTORY',
            message:
              'Tài sản đã có lịch sử cấp phát/ghi chú — không xóa được, hãy dùng Thanh lý.',
          });
        }
        await tx.delete(assetsTable).where(eq(assetsTable.id, id));
        // audit_log không FK asset → bản ghi này tồn tại sau khi asset mất (chủ đích, truy vết).
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'assets.delete',
          objectType: 'asset',
          objectId: id,
          detail: {},
        });
        return { ok: true };
      });
    } catch (error) {
      throw mapAssetPgError(error);
    }
  }

  async purgeDisposedAsset(id: string, version: number, actorSub: string) {
    return await this.db.transaction(async (tx) => {
      const current = await tx
        .select({
          id: assetsTable.id,
          version: assetsTable.version,
          status: assetsTable.status,
          code: assetsTable.code,
          purgedAt: assetsTable.purgedAt,
        })
        .from(assetsTable)
        .where(eq(assetsTable.id, id))
        .for('update');
      if (current.length === 0 || current[0].purgedAt != null) {
        throw new NotFoundException({
          code: 'ASSET_NOT_FOUND',
          message: 'Không tìm thấy tài sản này.',
        });
      }
      if (current[0].version !== version) {
        throw new ConflictException({
          code: 'STALE_VERSION',
          message: 'Trạng thái đã thay đổi, tải lại.',
        });
      }
      if (current[0].status !== 'disposed') {
        throw new ConflictException({
          code: 'NOT_DISPOSED',
          message: 'Chỉ xóa vĩnh viễn máy đã Thanh lý.',
        });
      }
      // Máy đang mượn dở (booking 'delivered' không bị hủy khi thanh lý — giữ cho
      // Admin thu hồi tay) → chặn purge để ticket in_use không trỏ máy đã biến mất
      // khỏi quản lý tài sản (audit 2026-07-16 M1).
      const inUse = await tx.execute<{ one: number }>(
        sql`SELECT 1 AS one FROM booking WHERE asset_id = ${id} AND state = 'delivered' LIMIT 1`,
      );
      if (inUse.rows.length > 0) {
        throw new ConflictException({
          code: 'ASSET_IN_USE',
          message:
            'Máy đang được mượn (chưa trả) — thu hồi trước khi xóa vĩnh viễn.',
        });
      }
      await tx.execute(
        sql`UPDATE assets SET purged_at = now(), version = version + 1, updated_at = now() WHERE id = ${id}`,
      );
      await this.audit.appendWithin(tx, {
        actor: actorSub,
        action: 'assets.purge',
        objectType: 'asset',
        objectId: id,
        detail: { code: current[0].code, note: 'soft-purge disposed (hidden)' },
      });
      return { ok: true };
    });
  }

  async assignOwner(
    id: string,
    assignedUserSub: string | null,
    version: number,
    actorSub: string,
    allocationNote: string | null = null,
  ) {
    try {
      return await this.db.transaction(async (tx) => {
        const cur = await tx
          .select({
            type: assetsTable.type,
            status: assetsTable.status,
            version: assetsTable.version,
            assignedUserSub: assetsTable.assignedUserSub,
          })
          .from(assetsTable)
          .where(eq(assetsTable.id, id))
          .for('update');
        if (cur.length === 0) {
          throw new NotFoundException({
            code: 'ASSET_NOT_FOUND',
            message: 'Không tìm thấy tài sản này.',
          });
        }
        const row = cur[0];
        if (row.type === 'software') {
          throw new BadRequestException({
            code: 'OWNER_NOT_APPLICABLE',
            message: 'Phần mềm không có người đứng tên (suy ra theo máy).',
          });
        }
        if (row.status === 'disposed') {
          throw new ConflictException({
            code: 'DISPOSED_TERMINAL',
            message: 'Tài sản đã thanh lý — hồ sơ đã chốt, không sửa được.',
          });
        }
        if (row.version !== version) {
          throw new ConflictException({
            code: 'STALE_VERSION',
            message: 'Trạng thái đã thay đổi, tải lại.',
          });
        }
        const upd = await tx.execute<{ version: number }>(sql`
          UPDATE assets
          SET assigned_user_sub = ${assignedUserSub},
              version = version + 1,
              updated_at = now()
          WHERE id = ${id}
          RETURNING version
        `);
        const newVersion = upd.rows[0].version;
        const before = row.assignedUserSub ?? null;
        if (before !== (assignedUserSub ?? null)) {
          await tx.insert(allocationHistoryTable).values({
            assetId: id,
            fromUserSub: before,
            toUserSub: assignedUserSub,
            note: allocationNote,
            actor: actorSub,
          });
        }
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'assets.assign_owner',
          objectType: 'asset',
          objectId: id,
          detail: { from: before, to: assignedUserSub ?? null },
        });
        return { ok: true, version: newVersion };
      });
    } catch (error) {
      throw mapAssetPgError(error);
    }
  }
}

/** So khớp old_<field> (kiểu pg raw: bigint=string, date=Date) với input mới. */
export function diffChanged(
  oldRow: Record<string, unknown>,
  input: AssetInput,
): Record<string, { from: unknown; to: unknown }> {
  const newValues: Record<string, unknown> = {
    code: input.code,
    type: input.type,
    configuration: input.configuration,
    cost: input.cost,
    start_date: input.startDate,
    end_date: input.endDate,
    floor: input.floor,
    note: input.note,
    contract: input.contract,
    serial: input.serial,
    brand: input.brand,
    assigned_user_sub: input.assignedUserSub,
    license_type: input.licenseType,
    license_name: input.licenseName,
  };
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of EDITABLE_FIELDS) {
    const from = norm(oldRow[`old_${field}`]);
    const to = norm(newValues[field]);
    if (from !== to) changed[field] = { from, to };
  }
  return changed;
}

/** Chuẩn hóa để so sánh: old đã ::text từ SQL; phía input số→string, null/undefined→null. */
function norm(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}
