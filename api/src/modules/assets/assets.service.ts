import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, ilike, isNotNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { usersTable } from '../users/users.schema';
import { allocationHistoryTable } from './allocation-history.schema';
import { assetsTable } from './assets.schema';

/** Trường Admin nhập được từ form (FR-30). status/is_pool KHÔNG ở đây — nghiệp vụ 2.6. */
export interface AssetInput {
  code: string;
  type: string;
  configuration: string | null;
  cost: number | null;
  startDate: string | null;
  endDate: string | null;
  floor: string | null;
  note: string | null;
  serial: string | null;
  brand: string | null;
  model: string | null;
  assignedUserSub: string | null;
}

export interface AssetListQuery {
  page: number;
  pageSize: number;
  /** Tìm MỘT ô: khớp mã tài sản HOẶC tên người đứng tên (FR-36, story 2.2). */
  search?: string;
  type?: string;
  status?: string;
  floor?: string;
}

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
  'model',
  'assigned_user_sub',
] as const;

interface PgError {
  code?: string;
  constraint?: string;
}

@Injectable()
export class AssetsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
  ) {}

  /**
   * Tạo tài sản — mặc định status in_use, pool TẮT (AC 1); mã trùng → 409 CODE_TAKEN.
   * Mutation + audit trong MỘT transaction (review 2.1): ghi vết thất bại →
   * rollback cả tạo (FR-35 — sổ tài sản không được "đổi mà mất vết").
   */
  async create(input: AssetInput, actorSub: string) {
    try {
      return await this.db.transaction(async (tx) => {
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
            model: input.model,
            assignedUserSub: input.assignedUserSub,
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
    try {
      // Mutation + audit MỘT transaction (review 2.1) — mất vết = rollback cả sửa
      return await this.db.transaction(async (tx) => {
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
              model = ${input.model},
              assigned_user_sub = ${input.assignedUserSub},
              version = a.version + 1,
              updated_at = now()
          FROM (SELECT * FROM assets WHERE id = ${id} FOR UPDATE) AS old
          WHERE a.id = old.id AND old.version = ${version}
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
            .select({ id: assetsTable.id })
            .from(assetsTable)
            .where(eq(assetsTable.id, id));
          if (exists.length === 0) {
            throw new NotFoundException({
              code: 'ASSET_NOT_FOUND',
              message: 'Không tìm thấy tài sản này.',
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
   * join users lấy tên người đứng tên; count(*) áp CÙNG where + join với items.
   */
  async list(query: AssetListQuery) {
    const conditions = [
      query.search
        ? or(
            ilike(assetsTable.code, `%${escapeLike(query.search)}%`),
            ilike(usersTable.fullName, `%${escapeLike(query.search)}%`),
          )
        : undefined,
      query.type ? eq(assetsTable.type, query.type) : undefined,
      query.status ? eq(assetsTable.status, query.status) : undefined,
      query.floor ? eq(assetsTable.floor, query.floor) : undefined,
    ].filter((c) => c !== undefined);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [items, totalRows] = await Promise.all([
      this.db
        .select({
          id: assetsTable.id,
          code: assetsTable.code,
          type: assetsTable.type,
          floor: assetsTable.floor,
          status: assetsTable.status,
          isPool: assetsTable.isPool,
          assignedUserSub: assetsTable.assignedUserSub,
          assignedUserName: usersTable.fullName,
        })
        .from(assetsTable)
        .leftJoin(usersTable, eq(assetsTable.assignedUserSub, usersTable.sub))
        .where(where)
        .orderBy(assetsTable.code)
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

  /** Giá trị distinct cho dropdown lọc (story 2.2) — loại + tầng đang có trong sổ. */
  async filterMeta() {
    const [types, floors] = await Promise.all([
      this.db
        .selectDistinct({ v: assetsTable.type })
        .from(assetsTable)
        .orderBy(assetsTable.type),
      this.db
        .selectDistinct({ v: assetsTable.floor })
        .from(assetsTable)
        .where(isNotNull(assetsTable.floor))
        .orderBy(assetsTable.floor),
    ]);
    return {
      types: types.map((r) => r.v),
      floors: floors.map((r) => r.v),
    };
  }

  async getById(id: string) {
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
        serial: assetsTable.serial,
        brand: assetsTable.brand,
        model: assetsTable.model,
        assignedUserSub: assetsTable.assignedUserSub,
        assignedUserName: usersTable.fullName,
        isPool: assetsTable.isPool,
        version: assetsTable.version,
      })
      .from(assetsTable)
      .leftJoin(usersTable, eq(assetsTable.assignedUserSub, usersTable.sub))
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
      return new BadRequestException({
        code: 'ASSIGNEE_NOT_FOUND',
        message: 'Người đứng tên không tồn tại trong hệ thống.',
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
    floor: input.floor,
    note: input.note,
    serial: input.serial,
    brand: input.brand,
    model: input.model,
    assigned_user_sub: input.assignedUserSub,
  };
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of EDITABLE_FIELDS) {
    const from = norm(oldRow[`old_${field}`]);
    const to = norm(newValues[field]);
    if (from !== to) changed[field] = { from, to };
  }
  return changed;
}

/** Escape ký tự đặc biệt của LIKE — search chứa % _ \ không thành wildcard (bài học 1.5). */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
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
