import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { eq, ilike, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { parseSaSubs } from '../auth/sa-subs';
import { usersTable } from './users.schema';

/** Claims tối thiểu từ PMH ID (hợp đồng ver:1 — docs integration). */
export interface PmhIdClaims {
  sub: string;
  email?: string;
  employee_code?: string;
  full_name?: string;
  groups?: string[];
}

export interface UserListQuery {
  search?: string;
  page: number;
  pageSize: number;
}

export interface UserListItem {
  sub: string;
  email: string | null;
  employeeCode: string | null;
  fullName: string | null;
  status: string;
  role: string;
  canLongTerm: boolean;
  canRecurring: boolean;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly saSubs = parseSaSubs(process.env);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
  ) {}

  /** Màn Vai trò (1.5): tìm theo tên/email, phân trang SERVER-side (NFR-5). */
  async list(query: UserListQuery): Promise<{
    items: UserListItem[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where = query.search
      ? or(
          ilike(usersTable.fullName, `%${escapeLike(query.search)}%`),
          ilike(usersTable.email, `%${escapeLike(query.search)}%`),
        )
      : undefined;
    const [items, totalRows] = await Promise.all([
      this.db
        .select({
          sub: usersTable.sub,
          email: usersTable.email,
          employeeCode: usersTable.employeeCode,
          fullName: usersTable.fullName,
          status: usersTable.status,
          role: usersTable.role,
          canLongTerm: usersTable.canLongTerm,
          canRecurring: usersTable.canRecurring,
        })
        .from(usersTable)
        .where(where)
        // tiebreaker `sub`: fullName trùng/null không làm phân trang nuốt/lặp bản ghi
        .orderBy(usersTable.fullName, usersTable.sub)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(where),
    ]);
    return {
      // Vai HIỆU LỰC: SA-từ-env hiển thị 'sa' (UI không mời gọi thao tác bị cấm)
      items: items.map((u) =>
        this.saSubs.has(u.sub) ? { ...u, role: 'sa' } : u,
      ),
      total: totalRows[0]?.n ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Bổ nhiệm/miễn nhiệm Admin (1.5, CHỈ SA gọi qua controller). Chặn:
   * tự đổi vai mình, đổi vai SA-từ-env; giá trị 'sa' bị DTO chặn từ ngoài.
   */
  async updateRole(
    targetSub: string,
    role: 'admin' | 'member',
    actorSub: string,
  ): Promise<void> {
    if (targetSub === actorSub) {
      throw new ForbiddenException({
        code: 'SELF_ROLE_CHANGE',
        message: 'Không thể tự đổi vai của chính mình.',
      });
    }
    if (this.saSubs.has(targetSub)) {
      throw new ForbiddenException({
        code: 'SA_ROLE_IMMUTABLE',
        message:
          'Không thể đổi vai của SA (SA chỉ định qua cấu hình hệ thống).',
      });
    }
    // NGUYÊN TỬ: đọc role cũ + ghi role mới trong MỘT câu lệnh (khóa hàng) —
    // 2 SA đổi vai đồng thời không tạo audit `from` sai (TOCTOU, review 1.5)
    const result = await this.db.execute<{ old_role: string }>(sql`
      UPDATE users AS u
      SET role = ${role}, updated_at = now()
      FROM (SELECT sub, role FROM users WHERE sub = ${targetSub} FOR UPDATE) AS old
      WHERE u.sub = old.sub
      RETURNING old.role AS old_role
    `);
    const oldRole = result.rows[0]?.old_role;
    if (oldRole === undefined) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'Không tìm thấy user này trong hệ thống.',
      });
    }
    await this.audit.append({
      actor: actorSub,
      action: 'users.role_change',
      objectType: 'user',
      objectId: targetSub,
      detail: { from: oldRole, to: role },
    });
  }

  /** 2 cờ quyền per-user (FR-3/FR-8) — Epic 3/4 check server-side qua đây. */
  async getPermissions(
    sub: string,
  ): Promise<{ canLongTerm: boolean; canRecurring: boolean }> {
    const rows = await this.db
      .select({
        canLongTerm: usersTable.canLongTerm,
        canRecurring: usersTable.canRecurring,
      })
      .from(usersTable)
      .where(eq(usersTable.sub, sub));
    return rows[0] ?? { canLongTerm: false, canRecurring: false };
  }

  /**
   * Gán/thu hồi 2 quyền (1.6, SA/Admin). Chỉ MEMBER có quyền này —
   * target admin/SA-env → 403 (Admin/SA không đi luồng mượn, mục 3 PRD).
   */
  async updatePermissions(
    targetSub: string,
    patch: { canLongTerm?: boolean; canRecurring?: boolean },
    actorSub: string,
  ): Promise<void> {
    if (this.saSubs.has(targetSub)) {
      throw new ForbiddenException({
        code: 'PERMISSIONS_MEMBER_ONLY',
        message:
          'Chỉ member mới có quyền mượn dài hạn/định kỳ — SA không đi luồng mượn.',
      });
    }
    // Nguyên tử: đọc giá trị cũ + role + ghi mới trong MỘT câu lệnh (bài học 1.5).
    // Điều kiện role='member' nằm ngay trong UPDATE — không có khe TOCTOU đổi vai.
    const result = await this.db.execute<{
      old_long: boolean;
      old_rec: boolean;
      role: string;
    }>(sql`
      UPDATE users AS u
      SET can_long_term = COALESCE(${patch.canLongTerm ?? null}, u.can_long_term),
          can_recurring = COALESCE(${patch.canRecurring ?? null}, u.can_recurring),
          updated_at = now()
      FROM (SELECT sub, role, can_long_term, can_recurring FROM users WHERE sub = ${targetSub} FOR UPDATE) AS old
      WHERE u.sub = old.sub AND old.role = 'member'
      RETURNING old.can_long_term AS old_long, old.can_recurring AS old_rec, old.role AS role
    `);
    if (result.rows.length === 0) {
      // Phân biệt 404 vs 403 (target tồn tại nhưng không phải member)
      const target = await this.findBySub(targetSub);
      if (!target) {
        throw new NotFoundException({
          code: 'USER_NOT_FOUND',
          message: 'Không tìm thấy user này trong hệ thống.',
        });
      }
      throw new ForbiddenException({
        code: 'PERMISSIONS_MEMBER_ONLY',
        message:
          'Chỉ member mới có quyền mượn dài hạn/định kỳ — Admin/SA không đi luồng mượn.',
      });
    }
    const old = result.rows[0];
    await this.audit.append({
      actor: actorSub,
      action: 'users.permissions_change',
      objectType: 'user',
      objectId: targetSub,
      detail: {
        canLongTerm: {
          from: old.old_long,
          to: patch.canLongTerm ?? old.old_long,
        },
        canRecurring: {
          from: old.old_rec,
          to: patch.canRecurring ?? old.old_rec,
        },
      },
    });
  }

  /** Upsert theo `sub` — email đổi KHÔNG tạo user mới (AD-8). */
  async upsertFromClaims(claims: PmhIdClaims): Promise<void> {
    const now = new Date();
    await this.db
      .insert(usersTable)
      .values({
        sub: claims.sub,
        email: claims.email ?? null,
        employeeCode: claims.employee_code ?? null,
        fullName: claims.full_name ?? null,
        groups: claims.groups ?? [],
        firstLoginAt: now,
        lastLoginAt: now,
      })
      .onConflictDoUpdate({
        target: usersTable.sub,
        set: {
          email: claims.email ?? null,
          employeeCode: claims.employee_code ?? null,
          fullName: claims.full_name ?? null,
          groups: claims.groups ?? [],
          lastLoginAt: now,
          updatedAt: now,
          // first_login_at giữ giá trị cũ nếu đã có
          firstLoginAt: sql`COALESCE(${usersTable.firstLoginAt}, ${now.toISOString()})`,
        },
      });
  }

  async findBySub(sub: string) {
    const rows = await this.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.sub, sub));
    return rows[0] ?? null;
  }

  async updateGroups(sub: string, groups: string[]): Promise<void> {
    const rows = await this.db
      .update(usersTable)
      .set({ groups, updatedAt: new Date() })
      .where(eq(usersTable.sub, sub))
      .returning({ sub: usersTable.sub });
    if (rows.length === 0) {
      // User chưa từng đăng nhập/sync — groups sẽ đúng lại ở lần login kế; không nuốt im lặng
      this.logger.warn(
        `groups_changed cho user chưa có trong DB (sub=${sub}) — bỏ qua, chờ login/sync`,
      );
    }
  }
}

/** Escape ký tự đặc biệt của LIKE — search chứa % _ \ không thành wildcard. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}
