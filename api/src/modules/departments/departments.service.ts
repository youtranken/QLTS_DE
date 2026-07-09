import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { departmentTable } from './departments.schema';

export interface DepartmentItem {
  id: string;
  name: string;
  active: boolean;
}

/**
 * Postgres unique-violation (index lower(name)) → 409, không "SELECT rồi INSERT" (TOCTOU).
 * Drizzle bọc lỗi pg trong DrizzleQueryError → code nằm ở `.cause.code`, không phải `.code`.
 */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

const NAME_TAKEN = {
  code: 'DEPARTMENT_NAME_TAKEN',
  message: 'Tên phòng ban đã tồn tại.',
};
const NOT_FOUND = {
  code: 'DEPARTMENT_NOT_FOUND',
  message: 'Không tìm thấy phòng ban này.',
};

@Injectable()
export class DepartmentsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
  ) {}

  /** Quản lý (7.1 AC2): mọi phòng ban cả active lẫn disabled, phân trang server-side. */
  async listAll(
    page: number,
    pageSize: number,
  ): Promise<{
    items: DepartmentItem[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const [items, totalRows] = await Promise.all([
      this.db
        .select({
          id: departmentTable.id,
          name: departmentTable.name,
          active: departmentTable.active,
        })
        .from(departmentTable)
        // tiebreak `id`: tên trùng/thứ tự ổn định qua phân trang
        .orderBy(asc(departmentTable.name), asc(departmentTable.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ n: sql<number>`count(*)::int` }).from(departmentTable),
    ]);
    return { items, total: totalRows[0]?.n ?? 0, page, pageSize };
  }

  /** Dropdown đặt máy (7.1 AC3): CHỈ active — booking cũ trỏ phòng ban disabled vẫn join tên OK. */
  async listActive(): Promise<DepartmentItem[]> {
    return this.db
      .select({
        id: departmentTable.id,
        name: departmentTable.name,
        active: departmentTable.active,
      })
      .from(departmentTable)
      .where(eq(departmentTable.active, true))
      .orderBy(asc(departmentTable.name), asc(departmentTable.id));
  }

  async create(name: string, actorSub: string): Promise<DepartmentItem> {
    let row: DepartmentItem | undefined;
    try {
      const rows = await this.db
        .insert(departmentTable)
        .values({ name })
        .returning({
          id: departmentTable.id,
          name: departmentTable.name,
          active: departmentTable.active,
        });
      row = rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(NAME_TAKEN);
      throw error;
    }
    await this.audit.append({
      actor: actorSub,
      action: 'departments.create',
      objectType: 'department',
      objectId: row.id,
      detail: { name: row.name },
    });
    return row;
  }

  async update(
    id: string,
    patch: { name?: string; active?: boolean },
    actorSub: string,
  ): Promise<DepartmentItem> {
    let row: DepartmentItem | undefined;
    try {
      const rows = await this.db
        .update(departmentTable)
        .set({
          // COALESCE-kiểu: bỏ qua field không gửi
          name: patch.name ?? sql`${departmentTable.name}`,
          active: patch.active ?? sql`${departmentTable.active}`,
          updatedAt: new Date(),
        })
        .where(eq(departmentTable.id, id))
        .returning({
          id: departmentTable.id,
          name: departmentTable.name,
          active: departmentTable.active,
        });
      row = rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(NAME_TAKEN);
      throw error;
    }
    if (!row) throw new NotFoundException(NOT_FOUND);
    await this.audit.append({
      actor: actorSub,
      action: 'departments.update',
      objectType: 'department',
      objectId: id,
      detail: { name: patch.name, active: patch.active },
    });
    return row;
  }
}
