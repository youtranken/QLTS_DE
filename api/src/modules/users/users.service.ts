import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { usersTable } from './users.schema';

/** Claims tối thiểu từ PMH ID (hợp đồng ver:1 — docs integration). */
export interface PmhIdClaims {
  sub: string;
  email?: string;
  employee_code?: string;
  full_name?: string;
  groups?: string[];
}

@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

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
    await this.db
      .update(usersTable)
      .set({ groups, updatedAt: new Date() })
      .where(eq(usersTable.sub, sub));
  }
}
