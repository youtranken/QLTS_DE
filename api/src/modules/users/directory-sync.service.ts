import { Inject, Injectable, Logger } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { DIRECTORY_CLIENT } from './directory.client';
import type { DirectoryClientApi, DirectoryGroup } from './directory.client';
import { usersTable } from './users.schema';

export interface DirectorySyncResult {
  total: number;
  created: number;
  updated: number;
  groups: DirectoryGroup[];
}

/**
 * Đồng bộ danh bạ (FR-4 phần cơ bản — job định kỳ + cảnh báo nghỉ việc là Epic 5).
 * Toàn bộ upsert trong MỘT transaction — lỗi giữa chừng không ghi dở dang (AC 4).
 * KHÔNG đụng role/first_login_at/last_login_at — dữ liệu của luồng login 1.2 (AC 7).
 */
@Injectable()
export class DirectorySyncService {
  private readonly logger = new Logger(DirectorySyncService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    @Inject(DIRECTORY_CLIENT) private readonly directory: DirectoryClientApi,
    private readonly audit: AuditWriterService,
  ) {}

  async sync(actor: string): Promise<DirectorySyncResult> {
    const [users, groups] = await Promise.all([
      this.directory.fetchUsers(),
      this.directory.fetchGroups(),
    ]);

    let created = 0;
    let updated = 0;
    await this.db.transaction(async (tx) => {
      const subs = users.map((u) => u.id);
      const existing = subs.length
        ? await tx
            .select({ sub: usersTable.sub })
            .from(usersTable)
            .where(inArray(usersTable.sub, subs))
        : [];
      const existingSubs = new Set(existing.map((r) => r.sub));
      const now = new Date();

      for (const user of users) {
        if (existingSubs.has(user.id)) {
          await tx
            .update(usersTable)
            .set({
              email: user.email ?? null,
              employeeCode: user.employee_code ?? null,
              fullName: user.full_name ?? null,
              groups: user.groups ?? [],
              status: user.status,
              updatedAt: now,
            })
            .where(inArray(usersTable.sub, [user.id]));
          updated += 1;
        } else {
          await tx.insert(usersTable).values({
            sub: user.id,
            email: user.email ?? null,
            employeeCode: user.employee_code ?? null,
            fullName: user.full_name ?? null,
            groups: user.groups ?? [],
            status: user.status,
          });
          created += 1;
        }
      }
    });

    const result: DirectorySyncResult = {
      total: users.length,
      created,
      updated,
      groups,
    };
    this.logger.log(
      `Directory sync: ${result.total} user, ${created} mới, ${updated} cập nhật`,
    );
    await this.audit.append({
      actor,
      action: 'users.directory_sync',
      objectType: 'users',
      detail: {
        total: result.total,
        created,
        updated,
        groups: groups.map((g) => g.name),
      },
    });
    return result;
  }
}
