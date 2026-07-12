import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
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
    // Chỉ MÁY tham gia unique code (phần mềm bỏ mã — sw-license-model).
    const codes = rows
      .filter((r) => r.type !== 'software')
      .map((r) => r.code)
      .filter((c): c is string => !!c);
    const existing =
      codes.length > 0
        ? await this.db
            .select({ code: assetsTable.code })
            .from(assetsTable)
            .where(inArray(assetsTable.code, codes))
        : [];
    const taken = new Set(existing.map((e) => e.code));
    for (const row of rows) {
      if (row.type !== 'software' && row.code && taken.has(row.code)) {
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
        // A1 (UAT 2026-07-12): giữ danh mục đồng bộ — loại/cấu hình mới trong file import tự vào
        // catalog (import là nguồn bulk). Ngăn "type mồ côi" như 'PC' từng lọt vào ngoài danh mục.
        await this.syncCatalog(tx, machines);
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
            const sameFile = machineIdByUserSub.get(match.sub) ?? [];
            const candidates = [...match.machineIds, ...sameFile];
            if (candidates.length === 1) {
              installedOn = candidates[0];
              // F4 (epic review): máy CÓ SẴN có thể bị dispose xen giữa matchUsers
              // (ngoài tx) và đây — lock + re-check; máy cùng file thì miễn
              if (!sameFile.includes(installedOn)) {
                const ok = await this.lockLiveMachine(tx, installedOn);
                if (!ok) installedOn = null;
              }
            }
          }
          // sổ cũ không có cột license: END DATE có → term; không → perpetual.
          // sw-license-model: phần mềm định danh bằng license_name (BỎ mã) → tên BẮT BUỘC
          // có: fallback CONFIGURATION → CODE cũ → 'Không tên'; code lưu NULL, không cấu hình.
          const licenseType = row.endDate ? 'term' : 'perpetual';
          const licenseName = row.configuration ?? row.code ?? 'Không tên';
          // F5: software disposed không bao giờ gắn được — đừng cắm cờ treo vô nghĩa
          const needsMap =
            row.status !== 'disposed' &&
            !!row.user &&
            (!match || installedOn === null);
          await tx.insert(assetsTable).values({
            code: null,
            type: 'software',
            configuration: null,
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
        assignedUserSub: assetsTable.assignedUserSub,
        installedOnAssetId: assetsTable.installedOnAssetId,
      })
      .from(assetsTable)
      .where(eq(assetsTable.needsUserMatch, true));
    if (pending.length === 0) return { matched: 0, remaining: 0 };
    const matches = await this.matchUsers(
      pending.map((p) => p.importedUserText).filter((u): u is string => !!u),
    );
    let matched = 0;
    let resolvedManually = 0;
    await this.db.transaction(async (tx) => {
      for (const row of pending) {
        // F1 (epic review): snapshot `pending` đọc NGOÀI tx — mọi UPDATE dưới đây
        // đều mang PREDICATE tự vệ (WHERE needs_user_match AND cột đích còn trống);
        // writer khác xen giữa → rowCount 0 → bỏ qua, không bao giờ 2 writer cùng thắng.

        // Admin đã xử tay (gán người/gắn máy qua form hoặc transfer 2.5) →
        // KHÔNG ghi đè quyết định tay; chỉ gỡ cờ (review 2.9)
        const manuallyResolved =
          row.type === 'software'
            ? row.installedOnAssetId !== null
            : row.assignedUserSub !== null;
        // TERMINAL 2.6: software disposed KHÔNG bao giờ gắn lại máy — gỡ cờ luôn
        const deadSoftware =
          row.type === 'software' && row.status === 'disposed';
        if (manuallyResolved || deadSoftware) {
          const cleared = await tx.execute<{ id: string }>(sql`
            UPDATE assets SET needs_user_match = false, updated_at = now()
            WHERE id = ${row.id} AND needs_user_match
            RETURNING id
          `);
          if (cleared.rows.length === 1) resolvedManually++;
          continue;
        }
        const match = row.importedUserText
          ? matches.get(normalize(row.importedUserText))
          : undefined;
        if (!match) continue;
        if (row.type === 'software') {
          if (match.machineIds.length !== 1) continue; // vẫn cần map tay
          const targetId = match.machineIds[0];
          // F4: máy đích có thể bị dispose sau matchUsers — lock + re-check
          const ok = await this.lockLiveMachine(tx, targetId);
          if (!ok) continue;
          const updated = await tx.execute<{ id: string }>(sql`
            UPDATE assets SET installed_on_asset_id = ${targetId},
              needs_user_match = false, version = version + 1, updated_at = now()
            WHERE id = ${row.id} AND needs_user_match
              AND installed_on_asset_id IS NULL AND status <> 'disposed'
            RETURNING id
          `);
          if (updated.rows.length !== 1) continue;
        } else {
          const updated = await tx.execute<{ id: string }>(sql`
            UPDATE assets SET assigned_user_sub = ${match.sub},
              needs_user_match = false, version = version + 1, updated_at = now()
            WHERE id = ${row.id} AND needs_user_match
              AND assigned_user_sub IS NULL
            RETURNING id
          `);
          if (updated.rows.length !== 1) continue;
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
      if (matched > 0 || resolvedManually > 0) {
        await this.audit.appendWithin(tx, {
          actor: actorSub,
          action: 'assets.import_rematch',
          objectType: 'assets_import',
          detail: {
            matched,
            resolvedManually,
            remaining: pending.length - matched - resolvedManually,
          },
        });
      }
    });
    return {
      matched,
      remaining: pending.length - matched - resolvedManually,
    };
  }

  /**
   * A1: upsert loại + cấu hình của các dòng máy vào catalog (kind='type'/'configuration').
   * Idempotent (ON CONFLICT). Giữ danh mục ⊇ mọi giá trị đang có → không có "giá trị mồ côi".
   */
  private async syncCatalog(
    tx: Pick<Database, 'execute'>,
    machines: ImportRow[],
  ): Promise<void> {
    const add = async (kind: string, raw: Array<string | null | undefined>) => {
      const uniq = [
        ...new Set(
          raw.map((v) => (v ?? '').trim()).filter((v) => v.length > 0),
        ),
      ];
      for (const value of uniq) {
        await tx.execute(sql`
          INSERT INTO catalog (kind, value) VALUES (${kind}, ${value})
          ON CONFLICT (kind, value) DO NOTHING
        `);
      }
    };
    await add(
      'type',
      machines.map((r) => r.type),
    );
    await add(
      'configuration',
      machines.map((r) => r.configuration),
    );
  }

  /**
   * Lock máy đích (FOR UPDATE, giữ đến hết tx) + xác nhận còn sống, không phải
   * software (F4 — cùng hợp đồng với assertInstallTarget của 2.4/2.5).
   */
  private async lockLiveMachine(
    tx: Pick<Database, 'execute'>,
    machineId: string,
  ): Promise<boolean> {
    const rows = await tx.execute<{ type: string; status: string }>(sql`
      SELECT type, status FROM assets WHERE id = ${machineId} FOR UPDATE
    `);
    const target = rows.rows[0];
    return (
      !!target && target.type !== 'software' && target.status !== 'disposed'
    );
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
      // pg detail: Key (code)=(X) already exists. — greedy: mã chứa ')' vẫn bắt đủ
      const m = /\(code\)=\((.+)\)/.exec(pg.detail ?? '');
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
