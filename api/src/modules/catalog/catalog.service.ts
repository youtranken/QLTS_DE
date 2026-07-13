import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import {
  catalogTable,
  CATALOG_KINDS,
  type CatalogKind,
} from './catalog.schema';

export interface CatalogItem {
  id: string;
  value: string;
  active: boolean;
  usage: number; // số tài sản đang ghi đúng value này (exact)
}

/** kind → tên cột trên bảng assets. Whitelist cứng — dùng trong sql.raw nên KHÔNG lấy từ input. */
const ASSET_COLUMN: Record<CatalogKind, string> = {
  type: 'type',
  brand: 'brand',
  configuration: 'configuration',
  // 'place' = cột floor trên assets (hồi sinh sau 7.6) → dropdown Place trong form.
  place: 'floor',
};

function assertKind(kind: string): asserts kind is CatalogKind {
  if (!(CATALOG_KINDS as readonly string[]).includes(kind)) {
    throw new BadRequestException({
      code: 'CATALOG_KIND_INVALID',
      message: 'kind phải là type | brand | configuration | place.',
    });
  }
}

const TAKEN = {
  code: 'CATALOG_VALUE_TAKEN',
  message: 'Giá trị đã tồn tại trong danh mục (kể cả khác hoa/thường).',
};
const NOT_FOUND = {
  code: 'CATALOG_NOT_FOUND',
  message: 'Không tìm thấy giá trị danh mục này.',
};

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
  ) {}

  /** Dropdown/quản lý: giá trị theo kind + số tài sản đang dùng (exact). activeOnly cho dropdown. */
  async listByKind(kind: string, activeOnly: boolean): Promise<CatalogItem[]> {
    assertKind(kind);
    const col = ASSET_COLUMN[kind];
    const conds = [eq(catalogTable.kind, kind)];
    if (activeOnly) conds.push(eq(catalogTable.active, true));
    // 'software' là loại HỆ THỐNG của phần mềm (đặt tự động) — không phải "Loại thiết bị" admin
    // chọn/gộp. Ẩn khỏi danh mục Loại (cả dropdown lẫn trang quản trị). Xem loadPair chặn gộp.
    if (kind === 'type') {
      conds.push(sql`lower(${catalogTable.value}) <> 'software'`);
    }
    const where = and(...conds);
    const rows = await this.db
      .select({
        id: catalogTable.id,
        value: catalogTable.value,
        active: catalogTable.active,
        usage: sql<number>`(
          SELECT count(*)::int FROM assets a WHERE a.${sql.raw(col)} = ${catalogTable.value}
        )`,
      })
      .from(catalogTable)
      .where(where)
      .orderBy(asc(catalogTable.value));
    return rows;
  }

  async create(
    kind: string,
    value: string,
    actorSub: string,
  ): Promise<CatalogItem> {
    assertKind(kind);
    const v = value.trim();
    if (!v) {
      throw new BadRequestException({
        code: 'CATALOG_VALUE_EMPTY',
        message: 'Giá trị không được rỗng.',
      });
    }
    // Chặn trùng case-insensitive (đi tới sạch dữ liệu) — seed cũ có thể còn biến thể hoa/thường
    // để GỘP, nhưng KHÔNG cho tạo MỚI trùng. Không thể ép ở tầng DB bằng UNIQUE(kind,lower(value))
    // vì index EXACT (kind,value) cố ý cho 'Laptop'/'laptop' cùng tồn tại để gộp. Pre-check này
    // best-effort (race 2 admin gõ cùng giá trị khác hoa/thường vẫn lọt) — chấp nhận: admin-only,
    // xác suất cực thấp, và tự chữa được bằng chính chức năng Gộp.
    const dup = await this.db
      .select({ id: catalogTable.id })
      .from(catalogTable)
      .where(
        and(
          eq(catalogTable.kind, kind),
          sql`lower(${catalogTable.value}) = lower(${v})`,
        ),
      );
    if (dup.length > 0) throw new ConflictException(TAKEN);

    let row: { id: string; value: string; active: boolean } | undefined;
    try {
      const rows = await this.db
        .insert(catalogTable)
        .values({ kind, value: v })
        .returning({
          id: catalogTable.id,
          value: catalogTable.value,
          active: catalogTable.active,
        });
      row = rows[0];
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      if (e?.code === '23505' || e?.cause?.code === '23505') {
        throw new ConflictException(TAKEN);
      }
      throw error;
    }
    await this.audit.append({
      actor: actorSub,
      action: 'catalog.create',
      objectType: 'catalog',
      objectId: row.id,
      detail: { kind, value: row.value },
    });
    return { ...row, usage: 0 };
  }

  /**
   * Sửa giá trị (8.2 rename): đổi tên danh mục + cascade text tài sản đang dùng giá trị cũ.
   * Trùng (case-insensitive) với entry KHÁC cùng kind → 409 (đó là gộp, không phải sửa).
   */
  async rename(
    id: string,
    value: string,
    actorSub: string,
  ): Promise<{ assetsUpdated: number }> {
    const v = value.trim();
    if (!v) {
      throw new BadRequestException({
        code: 'CATALOG_VALUE_EMPTY',
        message: 'Giá trị không được rỗng.',
      });
    }
    const cur = await this.db
      .select({ kind: catalogTable.kind, value: catalogTable.value })
      .from(catalogTable)
      .where(eq(catalogTable.id, id));
    if (cur.length === 0) throw new NotFoundException(NOT_FOUND);
    const { kind, value: oldValue } = cur[0];
    if (v === oldValue) return { assetsUpdated: 0 };
    // Chặn đổi tên dính 'software' (đối xứng loadPair/merge): cascade UPDATE assets.type qua/về
    // 'software' vi phạm CHECK software-fields (0012) → 23514 rollback → 500 khó hiểu (review P0 3.5).
    if (
      kind === 'type' &&
      (oldValue.toLowerCase() === 'software' || v.toLowerCase() === 'software')
    ) {
      throw new BadRequestException({
        code: 'CATALOG_RENAME_SOFTWARE',
        message: 'Không đổi tên qua/về loại hệ thống "software".',
      });
    }
    // Trùng với entry khác (kể cả khác hoa/thường) → gợi ý dùng Gộp
    const dup = await this.db
      .select({ id: catalogTable.id })
      .from(catalogTable)
      .where(
        and(
          eq(catalogTable.kind, kind),
          sql`lower(${catalogTable.value}) = lower(${v})`,
          sql`${catalogTable.id} <> ${id}`,
        ),
      );
    if (dup.length > 0) throw new ConflictException(TAKEN);

    const col = ASSET_COLUMN[kind as CatalogKind];
    const assetsUpdated = await this.db.transaction(async (tx) => {
      await tx
        .update(catalogTable)
        .set({ value: v, updatedAt: new Date() })
        .where(eq(catalogTable.id, id));
      const upd = await tx.execute(
        sql`UPDATE assets SET ${sql.raw(col)} = ${v}, version = version + 1, updated_at = now() WHERE ${sql.raw(col)} = ${oldValue}`,
      );
      await this.audit.appendWithin(tx, {
        actor: actorSub,
        action: 'catalog.rename',
        objectType: 'catalog',
        objectId: id,
        detail: {
          kind,
          from: oldValue,
          to: v,
          assetsUpdated: upd.rowCount ?? 0,
        },
      });
      return upd.rowCount ?? 0;
    });
    return { assetsUpdated };
  }

  /** Đổi hiển thị trong dropdown (ẩn/hiện) — KHÔNG đụng tài sản đang gắn giá trị cũ. */
  async setActive(
    id: string,
    active: boolean,
    actorSub: string,
  ): Promise<void> {
    const rows = await this.db
      .update(catalogTable)
      .set({ active, updatedAt: new Date() })
      .where(eq(catalogTable.id, id))
      .returning({ id: catalogTable.id, kind: catalogTable.kind });
    if (rows.length === 0) throw new NotFoundException(NOT_FOUND);
    await this.audit.append({
      actor: actorSub,
      action: 'catalog.set_active',
      objectType: 'catalog',
      objectId: id,
      detail: { active },
    });
  }

  /** Preview gộp: đếm số tài sản sẽ đổi text từ `from` → `to` (cùng kind). */
  async mergePreview(
    fromId: string,
    toId: string,
  ): Promise<{ fromValue: string; toValue: string; assetCount: number }> {
    const { from, to } = await this.loadPair(fromId, toId);
    const col = ASSET_COLUMN[from.kind as CatalogKind];
    const cnt = await this.db.execute(
      sql`SELECT count(*)::int AS n FROM assets WHERE ${sql.raw(col)} = ${from.value}`,
    );
    const assetCount = Number((cnt.rows[0] as { n: number }).n);
    return { fromValue: from.value, toValue: to.value, assetCount };
  }

  /**
   * Gộp `from` vào `to` (8.1): mọi tài sản đang ghi from.value → to.value, rồi XÓA entry from.
   * Một transaction: đổi text tài sản + xóa danh mục nguồn, audit kèm số tài sản đổi.
   */
  async merge(
    fromId: string,
    toId: string,
    actorSub: string,
  ): Promise<{ assetsUpdated: number }> {
    const { from, to } = await this.loadPair(fromId, toId);
    const col = ASSET_COLUMN[from.kind as CatalogKind];

    const assetsUpdated = await this.db.transaction(async (tx) => {
      // Bump version: admin đang mở sửa đúng máy này khi gộp → lần lưu sau nhận STALE_VERSION
      // thay vì lặng lẽ ghi đè giá trị cũ về (optimistic lock AD-4).
      const upd = await tx.execute(
        sql`UPDATE assets SET ${sql.raw(col)} = ${to.value}, version = version + 1, updated_at = now() WHERE ${sql.raw(col)} = ${from.value}`,
      );
      await tx.delete(catalogTable).where(eq(catalogTable.id, fromId));
      // Đích thành giá trị chuẩn → luôn hiện trong dropdown (usage vừa dồn vào đây; nếu nó đang ẩn
      // thì tài sản sẽ trỏ giá trị không chọn lại được khi tạo mới — review 8.1 M3).
      await tx
        .update(catalogTable)
        .set({ active: true, updatedAt: new Date() })
        .where(eq(catalogTable.id, toId));
      // Audit TRONG transaction (merge là thao tác phá hủy — xóa entry nguồn): commit-đổi mà
      // audit lỗi ngoài tx sẽ để mất vết append-only (AD-10, review 8.1 M5).
      await this.audit.appendWithin(tx, {
        actor: actorSub,
        action: 'catalog.merge',
        objectType: 'catalog',
        objectId: toId,
        detail: {
          kind: from.kind,
          from: from.value,
          to: to.value,
          assetsUpdated: upd.rowCount ?? 0,
        },
      });
      return upd.rowCount ?? 0;
    });

    return { assetsUpdated };
  }

  private async loadPair(
    fromId: string,
    toId: string,
  ): Promise<{
    from: { kind: string; value: string };
    to: { kind: string; value: string };
  }> {
    if (fromId === toId) {
      throw new BadRequestException({
        code: 'CATALOG_MERGE_SAME',
        message: 'Nguồn và đích gộp phải khác nhau.',
      });
    }
    const rows = await this.db
      .select({
        id: catalogTable.id,
        kind: catalogTable.kind,
        value: catalogTable.value,
      })
      .from(catalogTable)
      .where(sql`${catalogTable.id} IN (${fromId}, ${toId})`);
    const from = rows.find((r) => r.id === fromId);
    const to = rows.find((r) => r.id === toId);
    if (!from || !to) throw new NotFoundException(NOT_FOUND);
    if (from.kind !== to.kind) {
      throw new BadRequestException({
        code: 'CATALOG_MERGE_KIND',
        message: 'Chỉ gộp được hai giá trị cùng loại danh mục.',
      });
    }
    // Chặn gộp dính 'software': UPDATE assets.type qua/về 'software' vi phạm CHECK software-fields
    // (0012) → 23514 rollback → 500 khó hiểu. 'software' vốn đã ẩn khỏi danh mục Loại (listByKind).
    if (
      from.kind === 'type' &&
      (from.value.toLowerCase() === 'software' ||
        to.value.toLowerCase() === 'software')
    ) {
      throw new BadRequestException({
        code: 'CATALOG_MERGE_SOFTWARE',
        message: 'Không gộp giá trị loại hệ thống "software".',
      });
    }
    return { from, to };
  }
}
