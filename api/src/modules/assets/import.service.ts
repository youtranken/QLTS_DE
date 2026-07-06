import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { usersTable } from '../users/users.schema';
import { allocationHistoryTable } from './allocation-history.schema';
import { assetsTable } from './assets.schema';
import { parseWorkbook } from './import-parser';
import type { ImportRow } from './import-parser';

/** Actor ghi vào history/audit cho dòng import (FR-40). */
export const IMPORT_ACTOR = 'import go-live';

interface UserMatch {
  sub: string;
  machineIds: string[];
}

@Injectable()
export class ImportService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
  ) {}

  /** Preview (dry-run, AC 1): parse + check trùng DB — KHÔNG ghi gì. */
  async preview(buf: Buffer) {
    const rows = await parseWorkbook(buf);
    const codes = rows.map((r) => r.code).filter((c): c is string => !!c);
    const existing =
      codes.length > 0
        ? await this.db
            .select({ code: assetsTable.code })
            .from(assetsTable)
            .where(inArray(assetsTable.code, codes))
        : [];
    const taken = new Set(existing.map((e) => e.code));
    for (const row of rows) {
      if (row.code && taken.has(row.code)) {
        row.errors.push(`Mã "${row.code}" đã tồn tại trong sổ.`);
      }
    }
    return {
      total: rows.length,
      valid: rows.filter((r) => r.errors.length === 0).length,
      invalid: rows.filter((r) => r.errors.length > 0).length,
      rows,
    };
  }

  /**
   * Import thật (AC 3): parse LẠI (preview không phải nguồn sự thật), còn dòng
   * lỗi → 400; ghi ATOMIC 1 transaction — máy trước, software sau (AC 4);
   * 23505 giữa chừng (TOCTOU) → rollback toàn bộ + báo đúng dòng đụng.
   */
  async commit(buf: Buffer, actorSub: string) {
    const rows = await parseWorkbook(buf);
    if (rows.length === 0) {
      throw new BadRequestException({
        code: 'EMPTY_IMPORT',
        message: 'File không có dòng dữ liệu nào.',
      });
    }
    const invalid = rows.filter((r) => r.errors.length > 0);
    if (invalid.length > 0) {
      throw new BadRequestException({
        code: 'IMPORT_HAS_ERRORS',
        message: `Còn ${invalid.length} dòng lỗi — chạy preview, sửa file rồi import lại.`,
        rows: invalid.map((r) => ({
          rowNumber: r.rowNumber,
          errors: r.errors,
        })),
      });
    }
    // match USER một lượt ngoài tx (users chỉ upsert qua sync — ổn định đủ)
    const matches = await this.matchUsers(
      rows.map((r) => r.user).filter((u): u is string => !!u),
    );
    const machines = rows.filter((r) => r.type !== 'software');
    const softwares = rows.filter((r) => r.type === 'software');

    try {
      const result = await this.db.transaction(async (tx) => {
        let needsMatch = 0;
        // MÁY trước — software cùng file gắn được vào máy vừa import (AC 4)
        const machineIdByUserSub = new Map<string, string[]>();
        for (const row of machines) {
          const match = row.user ? matches.get(normalize(row.user)) : undefined;
          const assigned = row.user && match ? match.sub : null;
          const inserted = await tx
            .insert(assetsTable)
            .values({
              code: row.code!,
              type: row.type!,
              configuration: row.configuration,
              cost: row.cost,
              startDate: row.startDate,
              endDate: row.endDate,
              floor: row.floor,
              status: row.status!,
              note: row.note,
              assignedUserSub: assigned,
              importedUserText: row.user,
              needsUserMatch: !!row.user && !assigned,
            })
            .returning({ id: assetsTable.id });
          const id = inserted[0].id;
          if (assigned) {
            // seed lịch sử cấp phát đầu tiên — tab Cấp phát không rỗng (AC 5)
            await tx.insert(allocationHistoryTable).values({
              assetId: id,
              fromUserSub: null,
              toUserSub: assigned,
              note: null,
              actor: IMPORT_ACTOR,
            });
            if (row.status !== 'disposed') {
              const list = machineIdByUserSub.get(assigned) ?? [];
              list.push(id);
              machineIdByUserSub.set(assigned, list);
            }
          }
          if (row.user && !assigned) needsMatch++;
        }
        // SOFTWARE sau: gắn máy của USER nếu xác định được ĐÚNG 1 máy (AC 4)
        for (const row of softwares) {
          const match = row.user ? matches.get(normalize(row.user)) : undefined;
          let installedOn: string | null = null;
          if (match && row.status !== 'disposed') {
            const candidates = [
              ...match.machineIds,
              ...(machineIdByUserSub.get(match.sub) ?? []),
            ];
            if (candidates.length === 1) installedOn = candidates[0];
          }
          // sổ cũ không có cột license: END DATE có → term; không → perpetual
          // (tên license bắt buộc NOT NULL — fallback CONFIGURATION rồi CODE)
          const licenseType = row.endDate ? 'term' : 'perpetual';
          const licenseName =
            licenseType === 'perpetual'
              ? (row.configuration ?? row.code!)
              : row.configuration;
          const needsMap = !!row.user && (!match || installedOn === null);
          await tx.insert(assetsTable).values({
            code: row.code!,
            type: 'software',
            configuration: row.configuration,
            cost: row.cost,
            startDate: row.startDate,
            endDate: row.endDate,
            floor: row.floor,
            status: row.status!,
            note: row.note,
            licenseType,
            licenseName,
            installedOnAssetId: installedOn,
            importedUserText: row.user,
            needsUserMatch: needsMap,
          });
          if (needsMap) needsMatch++;
        }
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'assets.import_commit',
          objectType: 'assets_import',
          detail: {
            total: rows.length,
            machines: machines.length,
            softwares: softwares.length,
            needsUserMatch: needsMatch,
          },
        });
        return {
          created: rows.length,
          machines: machines.length,
          softwares: softwares.length,
          needsUserMatch: needsMatch,
        };
      });
      return result;
    } catch (error) {
      throw this.mapImportError(error, rows);
    }
  }

  /**
   * Nút "Đối chiếu lại" (AC 6, chạy nhiều lần): re-match imported_user_text
   * với users HIỆN TẠI — máy: gán người đứng tên + seed history; software:
   * gắn máy nếu đúng 1; khớp → gỡ đánh dấu.
   */
  async rematch(actorSub: string) {
    const pending = await this.db
      .select({
        id: assetsTable.id,
        type: assetsTable.type,
        status: assetsTable.status,
        importedUserText: assetsTable.importedUserText,
      })
      .from(assetsTable)
      .where(eq(assetsTable.needsUserMatch, true));
    if (pending.length === 0) return { matched: 0, remaining: 0 };
    const matches = await this.matchUsers(
      pending.map((p) => p.importedUserText).filter((u): u is string => !!u),
    );
    let matched = 0;
    await this.db.transaction(async (tx) => {
      for (const row of pending) {
        const match = row.importedUserText
          ? matches.get(normalize(row.importedUserText))
          : undefined;
        if (!match) continue;
        if (row.type === 'software') {
          if (match.machineIds.length !== 1) continue; // vẫn cần map tay
          await tx
            .update(assetsTable)
            .set({
              installedOnAssetId: match.machineIds[0],
              needsUserMatch: false,
              updatedAt: new Date(),
            })
            .where(eq(assetsTable.id, row.id));
        } else {
          await tx
            .update(assetsTable)
            .set({
              assignedUserSub: match.sub,
              needsUserMatch: false,
              updatedAt: new Date(),
            })
            .where(eq(assetsTable.id, row.id));
          await tx.insert(allocationHistoryTable).values({
            assetId: row.id,
            fromUserSub: null,
            toUserSub: match.sub,
            note: null,
            actor: IMPORT_ACTOR,
          });
        }
        matched++;
      }
      if (matched > 0) {
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'assets.import_rematch',
          objectType: 'assets_import',
          detail: { matched, remaining: pending.length - matched },
        });
      }
    });
    return { matched, remaining: pending.length - matched };
  }

  /**
   * So khớp USER → sub theo employee_code / email / họ tên (AD-8) —
   * chỉ nhận khi ĐÚNG 1 người; kèm danh sách máy đang đứng tên (cho software).
   */
  private async matchUsers(
    userTexts: string[],
  ): Promise<Map<string, UserMatch>> {
    const result = new Map<string, UserMatch>();
    if (userTexts.length === 0) return result;
    const users = await this.db
      .select({
        sub: usersTable.sub,
        email: usersTable.email,
        employeeCode: usersTable.employeeCode,
        fullName: usersTable.fullName,
      })
      .from(usersTable);
    const byKey = new Map<string, string[]>();
    for (const u of users) {
      for (const key of [u.employeeCode, u.email, u.fullName]) {
        if (!key) continue;
        const k = normalize(key);
        const list = byKey.get(k) ?? [];
        list.push(u.sub);
        byKey.set(k, list);
      }
    }
    const uniqueTexts = [...new Set(userTexts.map(normalize))];
    const matchedSubs: string[] = [];
    for (const text of uniqueTexts) {
      const subs = [...new Set(byKey.get(text) ?? [])];
      if (subs.length === 1) {
        result.set(text, { sub: subs[0], machineIds: [] });
        matchedSubs.push(subs[0]);
      }
    }
    if (matchedSubs.length > 0) {
      const machines = await this.db
        .select({ id: assetsTable.id, sub: assetsTable.assignedUserSub })
        .from(assetsTable)
        .where(
          and(
            inArray(assetsTable.assignedUserSub, matchedSubs),
            ne(assetsTable.type, 'software'),
            ne(assetsTable.status, 'disposed'),
          ),
        );
      for (const m of machines) {
        for (const um of result.values()) {
          if (um.sub === m.sub) um.machineIds.push(m.id);
        }
      }
    }
    return result;
  }

  /** 23505 giữa import (TOCTOU) → 409 kèm ĐÚNG DÒNG đụng; khác → giữ nguyên. */
  private mapImportError(error: unknown, rows: ImportRow[]): unknown {
    const pg = (
      error instanceof Error && 'cause' in error && error.cause
        ? error.cause
        : error
    ) as { code?: string; constraint?: string; detail?: string };
    if (pg?.code === '23505' && pg.constraint === 'assets_code_key') {
      // pg detail: Key (code)=(X) already exists.
      const m = /\(code\)=\((.+?)\)/.exec(pg.detail ?? '');
      const dupCode = m?.[1];
      const row = rows.find((r) => r.code === dupCode);
      return new ConflictException({
        code: 'IMPORT_CODE_TAKEN',
        message: `Mã "${dupCode ?? '?'}" vừa bị tạo song song — đã rollback TOÀN BỘ, không ghi dòng nào.`,
        rowNumber: row?.rowNumber ?? null,
      });
    }
    return error;
  }
}

/** Chuẩn hóa để so khớp: trim + lowercase + gộp khoảng trắng (KHÔNG bỏ dấu — an toàn). */
function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}
