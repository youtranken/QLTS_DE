import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as ExcelJS from 'exceljs';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { SystemConfigService } from '../config/system-config.service';
import { usersTable } from '../users/users.schema';
import { allocationHistoryTable } from './allocation-history.schema';
import { assetNoteTable } from './asset-note.schema';
import { assetsTable } from './assets.schema';
import { escapeLike } from '../../common/sql';
import { escapeCellDisplay } from './import-parser';

/** Trường Admin nhập được từ form (FR-30). status/is_pool KHÔNG ở đây — nghiệp vụ 2.6. */
export interface AssetInput {
  code: string;
  type: string;
  configuration: string | null;
  cost: number | null;
  startDate: string | null;
  endDate: string | null;
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
  /** Sắp xếp server-side (P1): cột (whitelist ở DTO) + hướng. Mặc định code asc. */
  sort?: string;
  dir?: string;
}

// 7.6: model/floor gỡ khỏi form/audit (cột DB giữ nullable, không drop — dữ liệu lịch sử).
const EDITABLE_FIELDS = [
  'code',
  'type',
  'configuration',
  'cost',
  'start_date',
  'end_date',
  'note',
  'serial',
  'brand',
  'assigned_user_sub',
  'license_type',
  'license_name',
] as const;

interface PgError {
  code?: string;
  constraint?: string;
}

/** Row đã FOR UPDATE cho thao tác vòng đời (2.6). */
interface LifecycleRow {
  type: string;
  status: string;
  isPool: boolean;
  version: number;
}

type LifecycleTx = Pick<Database, 'update' | 'insert' | 'execute' | 'select'>;

@Injectable()
export class AssetsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
    private readonly config: SystemConfigService,
  ) {}

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
    if (installedOnAssetId && input.type !== 'software') {
      throw new BadRequestException({
        code: 'SOFTWARE_FIELDS_ONLY',
        message: 'Chỉ phần mềm mới gắn được vào máy.',
      });
    }
    try {
      return await this.db.transaction(async (tx) => {
        if (installedOnAssetId) {
          await this.assertInstallTarget(tx, installedOnAssetId);
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
            note: input.note,
            serial: input.serial,
            brand: input.brand,
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
      throw this.mapPgError(error);
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
        const result = await tx.execute<Record<string, unknown>>(sql`
          UPDATE assets AS a
          SET code = ${input.code},
              type = ${input.type},
              configuration = ${input.configuration},
              cost = ${input.cost},
              start_date = ${input.startDate},
              end_date = ${input.endDate},
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
        // đổi người đứng tên (kể cả thu hồi → NULL) → bản ghi cấp phát A→B (2.3, AC 1)
        if ('assigned_user_sub' in changed) {
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
      throw this.mapPgError(error);
    }
  }

  /**
   * Danh sách phân trang SERVER-side (NFR-5) + tìm/lọc (FR-36, story 2.2) —
   * join users lấy tên người đứng tên; count(*) áp CÙNG where (join users cho
   * search; KHÔNG cần join host — WHERE không đụng host, join PK không nhân dòng).
   */
  /** Điều kiện tìm/lọc dùng chung list (2.2) + export (2.10) — MỘT nguồn sự thật.
   * `expiringBefore` = ngày cắt (VN) cho lọc "sắp hết hạn" (7.7); caller tính từ warningDays. */
  private buildListConditions(
    query: Pick<AssetListQuery, 'search' | 'type' | 'status' | 'expiring'>,
    expiringBefore: string | null = null,
  ) {
    const pat = query.search ? `%${escapeLike(query.search)}%` : null;
    const conditions = [
      pat
        ? or(
            ilike(assetsTable.code, pat),
            ilike(usersTable.fullName, pat),
            // 7.7: tìm theo software — license_name của chính software + software gắn máy
            ilike(assetsTable.licenseName, pat),
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

  /** Ngày cắt "sắp hết hạn" theo TZ VN + ngưỡng Config (7.7) — dùng cho list/export/count. */
  private async expiringCutoff(): Promise<string> {
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

  async list(query: AssetListQuery) {
    // FR-44: mốc cảnh báo đọc từ Config (AD-1) — SA chỉnh ở 6.3, hiệu lực ≤30s (TTL).
    // SystemConfigService.getInt đã validate int ≥ 0 tại nguồn (epic review) —
    // không cần fallback ở đây (||30 sẽ nuốt mất giá trị 0 = tắt cảnh báo).
    const warningDays = await this.config.getLicenseWarningDays();
    const host = alias(assetsTable, 'host');
    const where = this.buildListConditions(
      query,
      query.expiring ? await this.expiringCutoff() : null,
    );
    // Sắp xếp server-side: cột đã whitelist ở DTO; id làm tiebreaker → phân trang ổn định.
    const sortCol =
      query.sort === 'type'
        ? assetsTable.type
        : query.sort === 'status'
          ? assetsTable.status
          : query.sort === 'assignee'
            ? usersTable.fullName
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
          assignedUserSub: assetsTable.assignedUserSub,
          assignedUserName: usersTable.fullName,
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
        .where(where)
        .orderBy(orderExpr, assetsTable.id)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(assetsTable)
        .leftJoin(usersTable, eq(assetsTable.assignedUserSub, usersTable.sub))
        .where(where),
    ]);
    return {
      items,
      total: totalRows[0]?.n ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Chuyển license giữa máy hoặc gỡ về "chưa gắn máy" (2.5, FR-50) — endpoint
   * RIÊNG, không đi qua PUT sửa (AC 3 của 2.4). Optimistic lock như update.
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
      throw this.mapPgError(error);
    }
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
      guard: (row: LifecycleRow) => 'NOT_MACHINE' | 'INVALID_STATE' | null;
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
      throw this.mapPgError(error);
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
      guard: (row: LifecycleRow) => 'NOT_MACHINE' | 'INVALID_STATE' | null;
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
        return null;
      },
      apply: async (tx: LifecycleTx, row: LifecycleRow) => {
        await tx
          .update(assetsTable)
          .set({
            status: 'locked_repair',
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
        await tx
          .update(assetsTable)
          .set({
            status: 'disposed',
            isPool: false,
            version: row.version + 1,
            updatedAt: new Date(),
            ...(row.type === 'software' ? { installedOnAssetId: null } : {}),
          })
          .where(eq(assetsTable.id, id));
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
        return { detached, pool_cleared: row.isPool };
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

  /** Máy đích để cài software (2.4): tồn tại, KHÔNG phải software, KHÔNG thanh lý. */
  private async assertInstallTarget(
    tx: Pick<Database, 'select'>,
    targetId: string,
  ): Promise<void> {
    const rows = await tx
      .select({ type: assetsTable.type, status: assetsTable.status })
      .from(assetsTable)
      .where(eq(assetsTable.id, targetId))
      // giữ target đến hết tx create — chặn race dispose xen giữa (review 2.4);
      // 2.6: tx dispose cũng phải FOR UPDATE row máy + tự xử software đang cài
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

  /** Software đang cài trên một máy (2.4, AC 2) — 2.7 và Epic 3 dùng lại. */
  async listInstalledSoftware(assetId: string) {
    return this.db
      .select({
        id: assetsTable.id,
        code: assetsTable.code,
        licenseType: assetsTable.licenseType,
        licenseName: assetsTable.licenseName,
        endDate: assetsTable.endDate,
        status: assetsTable.status,
      })
      .from(assetsTable)
      .where(eq(assetsTable.installedOnAssetId, assetId))
      .orderBy(assetsTable.code);
  }

  /**
   * Lịch sử cấp phát một máy (2.3, AC 3) — thời gian GIẢM dần, chỉ đọc
   * (không có endpoint sửa/xóa). Join users 3 lần lấy tên from/to/actor.
   */
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

  /**
   * Export Excel theo bộ lọc hiện tại (2.10, FR-41) — KHÔNG phân trang, trần
   * 10000 dòng; escape NFR-10 mọi cell chuỗi (dữ liệu lưu raw — defer 2.9).
   */
  async exportExcel(
    query: Pick<AssetListQuery, 'search' | 'type' | 'status' | 'expiring'>,
    actorSub: string,
  ) {
    const host = alias(assetsTable, 'host');
    const expiringBefore = query.expiring ? await this.expiringCutoff() : null;
    const rows = await this.db
      .select({
        code: assetsTable.code,
        type: assetsTable.type,
        assignedUserSub: assetsTable.assignedUserSub,
        assignedUserName: usersTable.fullName,
        configuration: assetsTable.configuration,
        cost: assetsTable.cost,
        startDate: assetsTable.startDate,
        endDate: assetsTable.endDate,
        status: assetsTable.status,
        isPool: assetsTable.isPool,
        serial: assetsTable.serial,
        brand: assetsTable.brand,
        note: assetsTable.note,
        licenseType: assetsTable.licenseType,
        licenseName: assetsTable.licenseName,
        installedOnCode: host.code,
      })
      .from(assetsTable)
      .leftJoin(usersTable, eq(assetsTable.assignedUserSub, usersTable.sub))
      .leftJoin(host, eq(assetsTable.installedOnAssetId, host.id))
      .where(this.buildListConditions(query, expiringBefore))
      .orderBy(assetsTable.code)
      .limit(10_001);
    if (rows.length > 10_000) {
      throw new BadRequestException({
        code: 'EXPORT_TOO_LARGE',
        message: 'Quá 10.000 dòng — thu hẹp bộ lọc rồi export lại.',
      });
    }
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Tai san');
    sheet.addRow([
      'CODE',
      'TYPE',
      'USER',
      'CONFIGURATION',
      'COST',
      'START DATE',
      'END DATE',
      'STATUS',
      'POOL',
      'SERIAL',
      'BRAND',
      'NOTE',
      'LICENSE TYPE',
      'LICENSE NAME',
      'INSTALLED ON',
    ]);
    // NFR-10: escape mọi cell CHUỖI — số/ngày giữ kiểu, không thực thi được
    const esc = (v: string | null) => (v == null ? '' : escapeCellDisplay(v));
    for (const r of rows) {
      sheet.addRow([
        esc(r.code),
        esc(r.type),
        esc(r.assignedUserName ?? r.assignedUserSub),
        esc(r.configuration),
        r.cost ?? '',
        r.startDate ?? '',
        r.endDate ?? '',
        // enum bị CHECK khóa nhưng vẫn esc — "mọi ô chuỗi" không dựa invariant file khác
        esc(r.status),
        r.isPool ? 'x' : '',
        esc(r.serial),
        esc(r.brand),
        esc(r.note),
        esc(r.licenseType),
        esc(r.licenseName),
        esc(r.installedOnCode),
      ]);
    }
    // FR-43: kênh exfil phải có vết — ghi TRƯỚC khi trả file (best-effort,
    // nhất quán quyết định 2.8 download — PO confirm chung)
    await this.audit.append({
      actor: actorSub,
      action: 'assets.export',
      objectType: 'assets_export',
      detail: {
        filters: {
          search: query.search ?? null,
          type: query.type ?? null,
          status: query.status ?? null,
          expiring: query.expiring ?? false,
        },
        rowCount: rows.length,
      },
    });
    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      rowCount: rows.length,
    };
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
    const rows = await this.db
      .select({
        id: assetsTable.id,
        code: assetsTable.code,
        type: assetsTable.type,
        configuration: assetsTable.configuration,
        cost: assetsTable.cost,
        startDate: assetsTable.startDate,
        endDate: assetsTable.endDate,
        status: assetsTable.status,
        note: assetsTable.note,
        serial: assetsTable.serial,
        brand: assetsTable.brand,
        assignedUserSub: assetsTable.assignedUserSub,
        assignedUserName: usersTable.fullName,
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
      .where(eq(assetsTable.id, id));
    if (!rows[0]) {
      throw new NotFoundException({
        code: 'ASSET_NOT_FOUND',
        message: 'Không tìm thấy tài sản này.',
      });
    }
    return rows[0];
  }

  /** Map lỗi Postgres → lỗi nghiệp vụ; lỗi khác giữ nguyên cho filter 500. */
  private mapPgError(error: unknown): unknown {
    const pg = (
      error instanceof Error && 'cause' in error && error.cause
        ? error.cause
        : error
    ) as PgError;
    if (pg?.code === '23505' && pg.constraint === 'assets_code_key') {
      return new ConflictException({
        code: 'CODE_TAKEN',
        message: 'Mã tài sản đã tồn tại — mã phải duy nhất.',
      });
    }
    if (pg?.code === '23503') {
      if (pg.constraint === 'assets_installed_on_asset_id_fkey') {
        return new BadRequestException({
          code: 'INSTALL_TARGET_NOT_FOUND',
          message: 'Máy để cài phần mềm không tồn tại.',
        });
      }
      return new BadRequestException({
        code: 'ASSIGNEE_NOT_FOUND',
        message: 'Người đứng tên không tồn tại trong hệ thống.',
      });
    }
    if (pg?.code === '23514') {
      // CHECK 0012 là chốt cuối — app validate đã trả message đẹp trước đó
      return new BadRequestException({
        code: 'CONSTRAINT_VIOLATION',
        message: 'Dữ liệu vi phạm ràng buộc phần mềm/license.',
      });
    }
    if (pg?.code === '22007' || pg?.code === '22008') {
      return new BadRequestException({
        code: 'BAD_DATE',
        message: 'Ngày không hợp lệ.',
      });
    }
    return error;
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

/**
 * Ràng buộc software/license (2.4, FR-38) — validate app trả message rõ,
 * CHECK 0012 là chốt cuối ở tầng DB.
 */
export function validateSoftwareInput(input: AssetInput): void {
  const bad = (code: string, message: string) => {
    throw new BadRequestException({ code, message });
  };
  if (input.type === 'software') {
    if (input.licenseType !== 'term' && input.licenseType !== 'perpetual') {
      bad(
        'LICENSE_TYPE_REQUIRED',
        'Phần mềm phải chọn loại license: có thời hạn hoặc vĩnh viễn.',
      );
    }
    if (input.licenseType === 'term' && !input.endDate) {
      bad(
        'LICENSE_END_DATE_REQUIRED',
        'License có thời hạn phải có ngày hết hạn.',
      );
    }
    if (input.licenseType === 'perpetual') {
      if (!input.licenseName) {
        bad('LICENSE_NAME_REQUIRED', 'License vĩnh viễn phải có tên license.');
      }
      if (input.endDate) {
        bad(
          'LICENSE_PERPETUAL_NO_END',
          'License vĩnh viễn không có ngày hết hạn.',
        );
      }
    }
  } else if (input.licenseType || input.licenseName) {
    bad(
      'SOFTWARE_FIELDS_ONLY',
      'Trường license chỉ dành cho bản ghi phần mềm.',
    );
  }
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
