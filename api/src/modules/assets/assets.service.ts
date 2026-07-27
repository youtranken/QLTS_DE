import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { SystemConfigService } from '../config/system-config.service';
import { usersTable } from '../users/users.schema';
import { allocationHistoryTable } from './allocation-history.schema';
import { assetNoteTable } from './asset-note.schema';
import { assetsTable } from './assets.schema';
import { mapAssetPgError } from './asset-pg-error';
import { AssetSoftwareService } from './asset-software.service';
import { AssetsReadService } from './assets-read.service';
import { buildAssetListConditions } from './assets-query';
import {
  normalizeSoftwareInput,
  validateSoftwareInput,
} from './software-license';

/** Trường Admin nhập được từ form (FR-30). status/is_pool KHÔNG ở đây — nghiệp vụ 2.6. */
export interface AssetInput {
  /** NULL cho phần mềm (định danh bằng license_name). Máy bắt buộc có — validate ở service. */
  code: string | null;
  type: string;
  configuration: string | null;
  cost: number | null;
  startDate: string | null;
  endDate: string | null;
  /** Vị trí đặt máy (Place). Hồi sinh sau 7.6 theo yêu cầu UAT — cột floor sẵn có. */
  floor: string | null;
  note: string | null;
  serial: string | null;
  brand: string | null;
  assignedUserSub: string | null;
  /** Software (2.4): term|perpetual; non-software phải null. */
  licenseType: string | null;
  licenseName: string | null;
}

export interface AssetListQuery {
  page: number;
  pageSize: number;
  /** Tìm MỘT ô: khớp mã tài sản HOẶC tên người đứng tên (FR-36, story 2.2). */
  search?: string;
  type?: string;
  status?: string;
  /** 7.7: lọc "sắp hết hạn" (end_date ≤ ngưỡng) — gộp thiết bị + license. */
  expiring?: boolean;
  /** Sổ tài sản (máy) loại phần mềm ra — /phan-mem là danh sách phần mềm riêng. */
  excludeSoftware?: boolean;
  /** Lọc theo dõi hạn: end_date ∈ [endFrom, endTo] (YYYY-MM-DD, mỗi vế tuỳ chọn). */
  endFrom?: string;
  endTo?: string;
  /** Chi tiết nhóm license: lọc đúng tên license → liệt kê từng bản (seat). */
  licenseName?: string;
  /** Ẩn bản đã thanh lý (status=disposed) — /phan-mem chỉ hiện bản còn hiệu lực. */
  excludeDisposed?: boolean;
  /** Sắp xếp server-side (P1): cột (whitelist ở DTO) + hướng. Mặc định code asc. */
  sort?: string;
  dir?: string;
}

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
  'serial',
  'brand',
  'assigned_user_sub',
  'license_type',
  'license_name',
] as const;

/** Row đã FOR UPDATE cho thao tác vòng đời (2.6). */
interface LifecycleRow {
  type: string;
  status: string;
  isPool: boolean;
  version: number;
  assignedUserSub: string | null;
}

type LifecycleTx = Pick<Database, 'update' | 'insert' | 'execute' | 'select'>;

@Injectable()
export class AssetsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
    private readonly config: SystemConfigService,
    // Cụm phần mềm/license tách riêng (§6) — AssetsService phối hợp qua service công khai
    private readonly software: AssetSoftwareService,
    private readonly read: AssetsReadService,
  ) {}

  /**
   * A1 (UAT 2026-07-12): bảo đảm loại thiết bị luôn ∈ danh mục Loại (catalog kind='type').
   * UPSERT thay vì reject: form đã ép chọn từ dropdown (không typo được); đây là chốt bất biến
   * cho đường API/ghi trực tiếp + tự chữa, nhất quán với import → KHÔNG bao giờ có "type mồ côi".
   * (0034 backfill lo các orphan có sẵn + đưa vào dropdown; typo bulk admin gộp ở Danh mục.)
   */
  private async ensureTypeInCatalog(
    tx: Pick<Database, 'execute'>,
    type: string,
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO catalog (kind, value) VALUES ('type', ${type})
      ON CONFLICT (kind, value) DO NOTHING
    `);
  }

  /**
   * Tạo tài sản — mặc định status in_use, pool TẮT (AC 1); mã trùng → 409 CODE_TAKEN.
   * Mutation + audit trong MỘT transaction (review 2.1): ghi vết thất bại →
   * rollback cả tạo (FR-35 — sổ tài sản không được "đổi mà mất vết").
   */
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

  /**
   * Sửa tài sản — PUT full-set các trường form; optimistic lock cột `version`
   * (FR-49): version client gửi khác DB → 409 STALE_VERSION. Đọc giá trị cũ +
   * ghi mới NGUYÊN TỬ một câu lệnh (bài học 1.5 — audit from/to không đua).
   */
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

  /**
   * Xóa CỨNG tài sản "sạch" (story 11.1, UAT 2026-07-12). CHỈ khi chưa phát sinh gì:
   * allocation_history + asset_note append-only (AD-10/14) + FK NOT NULL không CASCADE →
   * tài sản đã dùng KHÔNG hard-delete được — đó là đường "Thanh lý" (disposed). Xóa = sửa nhầm.
   * Guard is_pool tường minh (không phải FK nên DELETE không tự 23503).
   */
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

  /**
   * SOFT-PURGE máy ĐÃ THANH LÝ (Kho thanh lý, "không còn dùng nữa"): set purged_at → ẨN khỏi
   * MỌI danh sách (coi như đã xóa) NHƯNG GIỮ nguyên row + allocation_history/asset_note (append-only
   * AD-10/14 — không xóa được) + audit. Hard-delete bất khả vì FK NOT NULL + trigger append-only.
   * CHỈ áp cho status='disposed' và chưa purge. Ghi audit 'assets.purge'.
   */
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

  /**
   * Đổi người đứng tên MÁY như thao tác RIÊNG (story 11.2, B3) — tách khỏi "Lưu thông tin máy".
   * CHỈ đụng assigned_user_sub (không ghi đè trường máy khác). Optimistic lock; đổi người →
   * append allocation_history (2.3). Phần mềm KHÔNG có người đứng tên (holder derive từ máy).
   */
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

  /**
   * Danh sách phân trang SERVER-side (NFR-5) + tìm/lọc (FR-36, story 2.2) —
   * join users lấy tên người đứng tên + host/host_user để derive holder phần mềm
   * (sw-license-model). count(*) áp CÙNG where + CÙNG join host (where có thể đụng
   * hostUser.fullName khi tìm theo người giữ máy; join PK không nhân dòng).
   */
  list(query: AssetListQuery) {
    return this.read.list(query);
  }

  /**
   * Gỡ MỌI license khỏi máy (2.5, FR-50) — 2.6 gọi TRONG tx thanh lý
   * (tx đó phải FOR UPDATE row máy trước — hợp đồng review 2.4).
   */
  async detachAllFrom(
    tx: Pick<Database, 'execute' | 'insert'>,
    machineId: string,
    actorSub: string,
  ): Promise<string[]> {
    const result = await tx.execute<{ code: string }>(sql`
      UPDATE assets
      SET installed_on_asset_id = NULL, version = version + 1, updated_at = now()
      WHERE installed_on_asset_id = ${machineId}
      RETURNING code
    `);
    const codes = result.rows.map((r) => r.code);
    if (codes.length > 0) {
      await this.audit.appendWithin(tx, {
        actor: actorSub,
        action: 'assets.license_detach_all',
        objectType: 'asset',
        objectId: machineId,
        detail: { detached: codes },
      });
    }
    return codes;
  }

  /**
   * Khóa máy sửa chữa (2.6, FR-33): BẮT BUỘC lý do, ETA tùy chọn — vào asset_note;
   * cờ pool GIỮ NGUYÊN. Chỉ từ in_use.
   */
  async lock(
    id: string,
    reason: string,
    eta: string | null,
    version: number,
    actorSub: string,
  ) {
    return this.lifecycle(
      id,
      version,
      actorSub,
      this.lockSpec(id, reason, eta, actorSub),
    );
  }

  /** Mở khóa (2.6): locked_repair → in_use; pool tự "như trước" vì không bao giờ bị đụng. */
  async unlock(id: string, version: number, actorSub: string) {
    return this.lifecycle(id, version, actorSub, this.unlockSpec(id, actorSub));
  }

  /**
   * Thanh lý (2.6, FR-32/50): TERMINAL. Máy → detachAllFrom (hợp đồng 2.5:
   * row máy đã FOR UPDATE trước); software → tự gỡ khỏi máy đang gắn.
   * Cascade hủy booking do orchestrator Tickets lo (3.10).
   */
  async dispose(id: string, version: number, actorSub: string) {
    return this.lifecycle(
      id,
      version,
      actorSub,
      this.disposeSpec(id, actorSub),
    );
  }

  /**
   * Tái sử dụng máy đã thanh lý (VĐ2): disposed → in_use, GIỮ mã MTS cũ (hoặc đổi mã mới).
   * KHÔNG tạo bản ghi mới → mã cũ không kẹt trong unique index. Đổi sang mã máy khác đang
   * dùng → PG unique violation → 409 (cảnh báo). Không cascade (máy disposed không booking).
   */
  async reactivate(
    id: string,
    version: number,
    actorSub: string,
    newCode: string | null,
  ) {
    return this.lifecycle(
      id,
      version,
      actorSub,
      this.reactivateSpec(id, newCode),
    );
  }

  /** Bật/gỡ pool (2.6, FR-31/33): CHỈ cờ đổi, status giữ nguyên; software/disposed chặn. */
  async setPool(
    id: string,
    isPool: boolean,
    version: number,
    actorSub: string,
  ) {
    return this.lifecycle(id, version, actorSub, this.setPoolSpec(id, isPool));
  }

  /**
   * Khung chung 4 thao tác vòng đời (2.6): tx + FOR UPDATE row TRƯỚC (hợp đồng
   * 2.5), guard type/state (409/400), optimistic lock (409), audit; apply trả
   * detail audit (null = no-op, không audit/bump).
   */
  private async lifecycle(
    id: string,
    version: number,
    actorSub: string,
    spec: {
      action: string;
      guard: (
        row: LifecycleRow,
      ) => 'NOT_MACHINE' | 'INVALID_STATE' | 'NOT_POOL' | null;
      apply: (
        tx: LifecycleTx,
        row: LifecycleRow,
      ) => Promise<Record<string, unknown> | null>;
    },
  ) {
    try {
      return await this.db.transaction((tx) =>
        this.runLifecycleWithin(tx, id, version, actorSub, spec),
      );
    } catch (error) {
      throw mapAssetPgError(error);
    }
  }

  /**
   * Thân vòng đời KHÔNG mở tx (3.10): orchestrator Tickets gọi trong CÙNG transaction với
   * cascade hủy booking. FOR UPDATE row máy TRƯỚC (serialize với trigger AD-15 FOR SHARE),
   * guard/version/audit như 2.6. KHÔNG bọc mapPgError (caller bọc).
   */
  async runLifecycleWithin(
    tx: LifecycleTx,
    id: string,
    version: number,
    actorSub: string,
    spec: {
      action: string;
      guard: (
        row: LifecycleRow,
      ) => 'NOT_MACHINE' | 'INVALID_STATE' | 'NOT_POOL' | null;
      apply: (
        tx: LifecycleTx,
        row: LifecycleRow,
      ) => Promise<Record<string, unknown> | null>;
    },
  ) {
    const rows = await tx
      .select({
        type: assetsTable.type,
        status: assetsTable.status,
        isPool: assetsTable.isPool,
        version: assetsTable.version,
        assignedUserSub: assetsTable.assignedUserSub,
      })
      .from(assetsTable)
      .where(eq(assetsTable.id, id))
      .for('update');
    const row = rows[0];
    if (!row) {
      throw new NotFoundException({
        code: 'ASSET_NOT_FOUND',
        message: 'Không tìm thấy tài sản này.',
      });
    }
    if (row.version !== version) {
      throw new ConflictException({
        code: 'STALE_VERSION',
        message: 'Trạng thái đã thay đổi, tải lại.',
      });
    }
    const violation = spec.guard(row);
    if (violation === 'NOT_MACHINE') {
      throw new BadRequestException({
        code: 'NOT_MACHINE',
        message: 'Thao tác này chỉ áp dụng cho máy, không áp dụng phần mềm.',
      });
    }
    if (violation === 'INVALID_STATE') {
      throw new ConflictException({
        code: 'INVALID_STATE',
        message: `Trạng thái hiện tại (${row.status}) không cho phép thao tác này.`,
      });
    }
    if (violation === 'NOT_POOL') {
      throw new ConflictException({
        code: 'NOT_POOL',
        message: 'Chỉ khóa sửa chữa được máy trong pool cho mượn.',
      });
    }
    const detail = await spec.apply(tx, row);
    if (detail === null) {
      return { ok: true, version: row.version };
    }
    await this.audit.appendWithin(tx, {
      actor: actorSub,
      action: spec.action,
      objectType: 'asset',
      objectId: id,
      detail: { from_status: row.status, ...detail },
    });
    return { ok: true, version: row.version + 1 };
  }

  /** Spec builders (3.10) — dùng chung cho lifecycle() 2.6 lẫn *Within orchestrator. */
  private lockSpec(
    id: string,
    reason: string,
    eta: string | null,
    actorSub: string,
  ) {
    return {
      action: 'assets.lock',
      guard: (row: LifecycleRow) => {
        if (row.type === 'software') return 'NOT_MACHINE' as const;
        if (row.status !== 'in_use') return 'INVALID_STATE' as const;
        // Khóa sửa chữa CHỈ cho máy pool (yêu cầu UAT): máy ngoài pool không đi luồng khóa.
        if (!row.isPool) return 'NOT_POOL' as const;
        return null;
      },
      apply: async (tx: LifecycleTx, row: LifecycleRow) => {
        await tx
          .update(assetsTable)
          .set({
            status: 'locked_repair',
            // lock_eta = ETA → sweep auto-unlock khi tới ngày (0036).
            lockEta: eta,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(assetsTable.id, id));
        await tx.insert(assetNoteTable).values({
          assetId: id,
          kind: 'lock',
          note: reason,
          eta,
          actor: actorSub,
        });
        return { reason, eta };
      },
    };
  }

  private disposeSpec(id: string, actorSub: string) {
    return {
      action: 'assets.dispose',
      guard: (row: LifecycleRow) =>
        row.status === 'disposed' ? ('INVALID_STATE' as const) : null,
      apply: async (tx: LifecycleTx, row: LifecycleRow) => {
        // Thanh lý máy → gỡ người đứng tên: máy đã bỏ không còn ai "đang giữ".
        // Nếu KHÔNG gỡ, offboarding-scan (đếm theo assigned_user_sub) sẽ báo phantom
        // vĩnh viễn cho nhân viên nghỉ việc từng giữ máy này (audit 2026-07-16 H1).
        const clearHolder =
          row.type !== 'software' && row.assignedUserSub != null;
        await tx
          .update(assetsTable)
          .set({
            status: 'disposed',
            isPool: false,
            lockEta: null, // thanh lý → xóa ETA khóa còn sót (dữ liệu sạch)
            version: row.version + 1,
            updatedAt: new Date(),
            ...(row.type === 'software'
              ? { installedOnAssetId: null }
              : { assignedUserSub: null }),
          })
          .where(eq(assetsTable.id, id));
        // Giữ allocation_history đầy đủ (AD-10 append-only): ghi vết trả về from→null.
        if (clearHolder) {
          await tx.insert(allocationHistoryTable).values({
            assetId: id,
            fromUserSub: row.assignedUserSub,
            toUserSub: null,
            note: null,
            actor: actorSub,
          });
        }
        let detached: string[] = [];
        if (row.type !== 'software') {
          detached = await this.detachAllFrom(tx, id, actorSub);
        }
        await tx.insert(assetNoteTable).values({
          assetId: id,
          kind: 'dispose',
          note: null,
          eta: null,
          actor: actorSub,
        });
        return {
          detached,
          pool_cleared: row.isPool,
          holder_cleared: clearHolder ? row.assignedUserSub : null,
        };
      },
    };
  }

  private reactivateSpec(id: string, newCode: string | null) {
    return {
      action: 'assets.reactivate',
      guard: (row: LifecycleRow) =>
        row.status !== 'disposed' ? ('INVALID_STATE' as const) : null,
      apply: async (tx: LifecycleTx, row: LifecycleRow) => {
        await tx
          .update(assetsTable)
          .set({
            status: 'in_use',
            lockEta: null,
            ...(newCode ? { code: newCode } : {}),
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(assetsTable.id, id));
        return { to_status: 'in_use', ...(newCode ? { new_code: newCode } : {}) };
      },
    };
  }

  private setPoolSpec(id: string, isPool: boolean) {
    return {
      action: 'assets.pool_change',
      guard: (row: LifecycleRow) => {
        if (row.type === 'software') return 'NOT_MACHINE' as const;
        if (row.status === 'disposed') return 'INVALID_STATE' as const;
        return null;
      },
      apply: async (tx: LifecycleTx, row: LifecycleRow) => {
        if (row.isPool === isPool) return null;
        await tx
          .update(assetsTable)
          .set({ isPool, version: row.version + 1, updatedAt: new Date() })
          .where(eq(assetsTable.id, id));
        return { from: row.isPool, to: isPool };
      },
    };
  }

  private unlockSpec(id: string, actorSub: string) {
    return {
      action: 'assets.unlock',
      guard: (row: LifecycleRow) => {
        if (row.type === 'software') return 'NOT_MACHINE' as const;
        if (row.status !== 'locked_repair') return 'INVALID_STATE' as const;
        return null;
      },
      apply: async (tx: LifecycleTx, row: LifecycleRow) => {
        await tx
          .update(assetsTable)
          .set({
            status: 'in_use',
            lockEta: null, // mở khóa → xóa ETA (sweep không đụng nữa)
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(assetsTable.id, id));
        await tx.insert(assetNoteTable).values({
          assetId: id,
          kind: 'unlock',
          note: null,
          eta: null,
          actor: actorSub,
        });
        return {};
      },
    };
  }

  /** *Within (3.10): orchestrator Tickets gọi trong tx của mình (cascade cùng transaction). */
  lockWithin(
    tx: LifecycleTx,
    id: string,
    reason: string,
    eta: string | null,
    version: number,
    actorSub: string,
  ) {
    return this.runLifecycleWithin(
      tx,
      id,
      version,
      actorSub,
      this.lockSpec(id, reason, eta, actorSub),
    );
  }

  unlockWithin(tx: LifecycleTx, id: string, version: number, actorSub: string) {
    return this.runLifecycleWithin(
      tx,
      id,
      version,
      actorSub,
      this.unlockSpec(id, actorSub),
    );
  }

  disposeWithin(
    tx: LifecycleTx,
    id: string,
    version: number,
    actorSub: string,
  ) {
    return this.runLifecycleWithin(
      tx,
      id,
      version,
      actorSub,
      this.disposeSpec(id, actorSub),
    );
  }

  setPoolWithin(
    tx: LifecycleTx,
    id: string,
    isPool: boolean,
    version: number,
    actorSub: string,
  ) {
    return this.runLifecycleWithin(
      tx,
      id,
      version,
      actorSub,
      this.setPoolSpec(id, isPool),
    );
  }

  /**
   * Auto-unlock (0036): máy POOL đang khóa sửa chữa mà ETA đã tới (ngày VN) → tự mở khóa
   * để mượn lại. Sweep chạy ở worker (đăng ký ở AssetsSweepRegistrar). Bump version +
   * ghi note kind='unlock' + audit 'assets.auto_unlock' (actor 'system'). Trả số máy đã mở.
   */
  async autoUnlockExpiredLocks(): Promise<number> {
    return this.db.transaction(async (tx) => {
      // KHÔNG lọc is_pool: máy đã khóa vốn TỪNG là pool (guard lock chỉ cho pool); nếu sau
      // đó bị gỡ pool lúc đang khóa vẫn phải tự mở khi tới ETA (tránh kẹt khóa vĩnh viễn).
      const unlocked = await tx.execute<{ id: string }>(sql`
        UPDATE assets
        SET status = 'in_use', lock_eta = NULL, version = version + 1, updated_at = now()
        WHERE status = 'locked_repair'
          AND lock_eta IS NOT NULL
          AND lock_eta <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        RETURNING id
      `);
      for (const r of unlocked.rows) {
        await tx.insert(assetNoteTable).values({
          assetId: r.id,
          kind: 'unlock',
          note: 'Tự mở khóa: đã tới ngày dự kiến (ETA).',
          eta: null,
          actor: 'system',
        });
        await this.audit.appendWithin(tx, {
          actor: 'system',
          action: 'assets.auto_unlock',
          objectType: 'asset',
          objectId: r.id,
          detail: {},
        });
      }
      return unlocked.rows.length;
    });
  }

  /** Máy đích để cài software (2.4): tồn tại, KHÔNG phải software, KHÔNG thanh lý. */

  /**
   * Lịch sử cấp phát một máy (2.3, AC 3) — thời gian GIẢM dần, chỉ đọc
   * (không có endpoint sửa/xóa). Join users 3 lần lấy tên from/to/actor.
   */
  listAllocations(assetId: string) {
    return this.read.listAllocations(assetId);
  }

  listNotes(assetId: string) {
    return this.read.listNotes(assetId);
  }

  // Export Excel (2.10) TÁCH sang AssetExportService (§6): exportAssets (máy) +
  // exportSoftware (license, derive holder). Controller gọi trực tiếp service đó.

  filterMeta() {
    return this.read.filterMeta();
  }

  getById(id: string) {
    return this.read.getById(id);
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
