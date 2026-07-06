import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { DIRECTORY_CLIENT } from './directory.client';
import type {
  DirectoryClientApi,
  DirectoryGroup,
  DirectoryUser,
} from './directory.client';
import { usersTable } from './users.schema';

export interface DirectorySyncResult {
  total: number;
  created: number;
  updated: number;
  /** bản ghi không đổi so với DB — không UPDATE, không bump updated_at */
  unchanged: number;
  /** bản ghi nguồn hỏng (thiếu id) — bỏ qua, không phá cả đợt sync */
  skipped: number;
  groups: DirectoryGroup[];
}

const SELECT_CHUNK = 5_000;
const INSERT_CHUNK = 500;

/**
 * Đồng bộ danh bạ (FR-4 phần cơ bản — job định kỳ + cảnh báo nghỉ việc là Epic 5).
 * - Sanitize nguồn: bỏ record thiếu id, khử trùng lặp id (bản ghi sau thắng).
 * - Toàn bộ ghi trong MỘT transaction; INSERT dùng ON CONFLICT DO UPDATE —
 *   2 sync đồng thời không nổ PK violation (AC 4).
 * - CHỈ UPDATE bản ghi thực sự đổi (không bump updated_at vô nghĩa); field
 *   undefined trong nguồn → GIỮ giá trị cũ (chống wipe dữ liệu khi API bỏ sót
 *   field); field null tường minh → ghi null.
 * - KHÔNG đụng role/first_login_at/last_login_at — dữ liệu luồng login 1.2 (AC 7).
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
    const [rawUsers, groups] = await Promise.all([
      this.directory.fetchUsers(),
      this.directory.fetchGroups(),
    ]);

    const valid = rawUsers.filter(
      (u) => typeof u.id === 'string' && u.id.length > 0,
    );
    const skipped = rawUsers.length - valid.length;
    if (skipped > 0) {
      this.logger.warn(`Directory sync: bỏ qua ${skipped} record thiếu id`);
    }
    const users = [...new Map(valid.map((u) => [u.id, u])).values()];

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const deletedSubs: string[] = [];

    try {
      await this.db.transaction(async (tx) => {
        // Đọc bản ghi hiện có (chunk để không vượt giới hạn bind params)
        const existing = new Map<string, ExistingRow>();
        for (const chunk of chunks(
          users.map((u) => u.id),
          SELECT_CHUNK,
        )) {
          const rows = await tx
            .select({
              sub: usersTable.sub,
              email: usersTable.email,
              employeeCode: usersTable.employeeCode,
              fullName: usersTable.fullName,
              groups: usersTable.groups,
              status: usersTable.status,
            })
            .from(usersTable)
            .where(inArray(usersTable.sub, chunk));
          for (const r of rows) {
            existing.set(r.sub, r);
          }
        }

        const toInsert: DirectoryUser[] = [];
        const toUpdate: DirectoryUser[] = [];
        for (const user of users) {
          const current = existing.get(user.id);
          if (!current) {
            toInsert.push(user);
          } else if (differs(current, user)) {
            toUpdate.push(user);
          } else {
            unchanged += 1;
          }
          if (user.status === 'deleted' && current?.status !== 'deleted') {
            deletedSubs.push(user.id);
          }
        }

        // INSERT batch + ON CONFLICT DO UPDATE — an toàn khi 2 sync đua nhau
        for (const chunk of chunks(toInsert, INSERT_CHUNK)) {
          await tx
            .insert(usersTable)
            .values(
              chunk.map((u) => ({
                sub: u.id,
                email: u.email ?? null,
                employeeCode: u.employee_code ?? null,
                fullName: u.full_name ?? null,
                groups: u.groups ?? [],
                status: u.status,
              })),
            )
            .onConflictDoUpdate({
              target: usersTable.sub,
              set: {
                email: sql`excluded.email`,
                employeeCode: sql`excluded.employee_code`,
                fullName: sql`excluded.full_name`,
                groups: sql`excluded.groups`,
                status: sql`excluded.status`,
                updatedAt: sql`now()`,
              },
            });
          created += chunk.length;
        }

        // UPDATE chỉ bản ghi đổi; field undefined → giữ giá trị cũ
        const now = new Date();
        for (const user of toUpdate) {
          const current = existing.get(user.id)!;
          await tx
            .update(usersTable)
            .set({
              email: pick(user.email, current.email),
              employeeCode: pick(user.employee_code, current.employeeCode),
              fullName: pick(user.full_name, current.fullName),
              groups: user.groups ?? current.groups,
              status: user.status,
              updatedAt: now,
            })
            .where(inArray(usersTable.sub, [user.id]));
          updated += 1;
        }
      });
    } catch (error) {
      this.logger.error(
        `Directory sync thất bại (đã rollback): ${(error as Error).message}`,
      );
      throw new InternalServerErrorException({
        code: 'DIRECTORY_SYNC_FAILED',
        message:
          'Đồng bộ thất bại — mọi thay đổi đã được hoàn tác, vui lòng thử lại.',
      });
    }

    if (deletedSubs.length > 0) {
      // Phiên của user deleted tự chết trong ≤5' (PMH ID thu hồi refresh token);
      // xử lý offboarding đầy đủ (hủy booking, mail, badge) là Epic 5 — story 5.5
      this.logger.warn(
        `Directory sync: phát hiện ${deletedSubs.length} user chuyển deleted: ${deletedSubs.join(', ')}`,
      );
    }

    const result: DirectorySyncResult = {
      total: rawUsers.length,
      created,
      updated,
      unchanged,
      skipped,
      groups,
    };
    this.logger.log(
      `Directory sync: ${result.total} user, ${created} mới, ${updated} cập nhật, ${unchanged} không đổi, ${skipped} bỏ qua`,
    );
    await this.audit.append({
      actor,
      action: 'users.directory_sync',
      objectType: 'users',
      detail: {
        total: result.total,
        created,
        updated,
        unchanged,
        skipped,
        deleted_detected: deletedSubs,
        groups: groups.map((g) => g.name),
      },
    });
    return result;
  }
}

interface ExistingRow {
  sub: string;
  email: string | null;
  employeeCode: string | null;
  fullName: string | null;
  groups: unknown;
  status: string;
}

/** field undefined trong nguồn = không có thông tin → giữ giá trị cũ; null tường minh → null. */
function pick<T>(incoming: T | null | undefined, current: T | null): T | null {
  return incoming === undefined ? current : incoming;
}

function differs(current: ExistingRow, user: DirectoryUser): boolean {
  if (user.email !== undefined && (user.email ?? null) !== current.email)
    return true;
  if (
    user.employee_code !== undefined &&
    (user.employee_code ?? null) !== current.employeeCode
  )
    return true;
  if (
    user.full_name !== undefined &&
    (user.full_name ?? null) !== current.fullName
  )
    return true;
  if (user.status !== current.status) return true;
  if (
    user.groups !== undefined &&
    JSON.stringify(user.groups ?? []) !== JSON.stringify(current.groups ?? [])
  )
    return true;
  return false;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
