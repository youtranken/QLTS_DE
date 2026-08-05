import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import * as ExcelJS from 'exceljs';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { usersTable } from '../users/users.schema';
import { assetsTable } from './assets.schema';
import { AssetSoftwareService } from './asset-software.service';
import { buildAssetListConditions } from './assets-query';
import { escapeCellDisplay } from './import-parser';

type ExportQuery = {
  search?: string;
  type?: string;
  status?: string;
  expiring?: boolean;
  endFrom?: string;
  endTo?: string;
  /** Ẩn máy đã thanh lý — khớp mặc định sổ tài sản trên FE. */
  excludeDisposed?: boolean;
  /** Chọn-để-xuất (5.1): chỉ xuất đúng các máy được tick; rỗng → theo bộ lọc như cũ. */
  ids?: string[];
};

/**
 * Cụm export Excel tách khỏi AssetsService (§6 — assets.service đã >ngưỡng).
 * sw-license-model follow-up: TÁCH RIÊNG export Tài sản (máy) và export Phần mềm
 * (license). Export gộp cũ bỏ derive holder phần mềm để né timeout 10k dòng; nay
 * software ít dòng → export software-only derive được người đứng tên theo máy.
 */
@Injectable()
export class AssetExportService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
    private readonly software: AssetSoftwareService,
  ) {}

  /**
   * Export sổ TÀI SẢN (máy) theo bộ lọc (2.10, FR-41) — KHÔNG phân trang, trần
   * 10000 dòng; escape NFR-10 mọi cell chuỗi. LOẠI phần mềm (có export riêng).
   */
  async exportAssets(query: ExportQuery, actorSub: string) {
    const expiringBefore = query.expiring
      ? await this.software.expiringCutoff()
      : null;
    const base = buildAssetListConditions(query, expiringBefore);
    // Tách sổ tài sản khỏi license: chỉ máy (type <> 'software').
    const notSoftware = sql`${assetsTable.type} <> 'software'`;
    const idCond =
      query.ids && query.ids.length
        ? inArray(assetsTable.id, query.ids)
        : undefined;
    const where = and(
      ...[notSoftware, base, idCond].filter((c): c is NonNullable<typeof c> =>
        Boolean(c),
      ),
    );
    const rows = await this.db
      .select({
        id: assetsTable.id,
        code: assetsTable.code,
        type: assetsTable.type,
        assignedUserSub: assetsTable.assignedUserSub,
        assignedUserName: usersTable.fullName,
        department: usersTable.department,
        configuration: assetsTable.configuration,
        software: sql<string | null>`(
          SELECT string_agg(sw.license_name, ', ' ORDER BY sw.license_name)
          FROM ${assetsTable} sw
          WHERE sw.installed_on_asset_id = ${assetsTable.id}
            AND sw.type = 'software'
            AND sw.status <> 'disposed'
            AND sw.purged_at IS NULL
        )`,
        cost: assetsTable.cost,
        startDate: assetsTable.startDate,
        endDate: assetsTable.endDate,
        floor: assetsTable.floor,
        status: assetsTable.status,
        isPool: assetsTable.isPool,
        serial: assetsTable.serial,
        brand: assetsTable.brand,
        note: assetsTable.note,
      })
      .from(assetsTable)
      .leftJoin(usersTable, eq(assetsTable.assignedUserSub, usersTable.sub))
      .where(where)
      .orderBy(assetsTable.code)
      .limit(10_001);
    this.assertNotTooLarge(rows.length);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Tai san');
    // Cột theo đúng thứ tự bảng Tài sản trên FE (Type→Code→User→Department→Config→Software→Cost→
    // Start→End→Place→Status), rồi các trường phụ (Serial/Brand/Note/Pool) ở cuối. Cột SOFTWARE =
    // tên các license đang cài trên máy (string_agg trong subquery — không N+1, an toàn với trần 10k).
    sheet.addRow([
      'TYPE',
      'CODE',
      'USER',
      'DEPARTMENT',
      'CONFIGURATION',
      'SOFTWARE',
      'COST',
      'START DATE',
      'END DATE',
      'PLACE',
      'STATUS',
      'SERIAL',
      'BRAND',
      'NOTE',
      'POOL',
    ]);
    const esc = (v: string | null) => (v == null ? '' : escapeCellDisplay(v));
    for (const r of rows) {
      sheet.addRow([
        esc(r.type),
        esc(r.code),
        esc(r.assignedUserName ?? r.assignedUserSub),
        esc(r.department),
        esc(r.configuration),
        esc(r.software),
        r.cost ?? '',
        r.startDate ?? '',
        r.endDate ?? '',
        esc(r.floor),
        esc(r.status),
        esc(r.serial),
        esc(r.brand),
        esc(r.note),
        // Máy thuộc Pool → dấu ✓ (dễ đọc/lọc hơn 'x' vốn bị hiểu nhầm là "không").
        r.isPool ? '✓' : '',
      ]);
    }
    // Sheet 2 "Phần mềm" — mỗi dòng = 1 cặp (máy × phần mềm) để lọc/đếm/pivot dễ trong Excel
    // (cột SOFTWARE ở sheet 1 gộp nhiều tên vào một ô, khó xử lý). Chỉ dựng khi có máy.
    await this.addSoftwareBreakdownSheet(workbook, rows);
    await this.audit.append({
      actor: actorSub,
      action: 'assets.export',
      objectType: 'assets_export',
      detail: { filters: this.filterDetail(query), rowCount: rows.length },
    });
    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      rowCount: rows.length,
    };
  }

  /**
   * Export PHẦN MỀM/license riêng — derive người đứng tên theo MÁY (JOIN host),
   * cột hướng license (Tên license · Máy · Người · Kỳ hạn). Software ít dòng nên
   * derive an toàn (không lo timeout như export gộp). Trần 10000 như export tài sản.
   */
  async exportSoftware(query: ExportQuery, actorSub: string) {
    const host = alias(assetsTable, 'host');
    const hostUser = alias(usersTable, 'host_user');
    const expiringBefore = query.expiring
      ? await this.software.expiringCutoff()
      : null;
    // Ép type=software + cho tìm theo người giữ máy (hostUser.fullName).
    const where = buildAssetListConditions(
      { ...query, type: 'software' },
      expiringBefore,
      hostUser.fullName,
    );
    const rows = await this.db
      .select({
        licenseName: assetsTable.licenseName,
        licenseType: assetsTable.licenseType,
        installedOnCode: host.code,
        holderName: hostUser.fullName,
        holderSub: host.assignedUserSub,
        startDate: assetsTable.startDate,
        endDate: assetsTable.endDate,
        status: assetsTable.status,
        cost: assetsTable.cost,
        serial: assetsTable.serial,
        brand: assetsTable.brand,
        note: assetsTable.note,
      })
      .from(assetsTable)
      // usersTable join để buildAssetListConditions khớp own-holder (null cho software) — vô hại
      .leftJoin(usersTable, eq(assetsTable.assignedUserSub, usersTable.sub))
      .leftJoin(host, eq(assetsTable.installedOnAssetId, host.id))
      .leftJoin(hostUser, eq(host.assignedUserSub, hostUser.sub))
      .where(where)
      .orderBy(assetsTable.licenseName)
      .limit(10_001);
    this.assertNotTooLarge(rows.length);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Phan mem');
    // Cột A = TÊN PHẦN MỀM (gộp ô theo nhóm license); cột B+ = chi tiết TỪNG BẢN (seat).
    sheet.addRow([
      'TÊN PHẦN MỀM',
      'MÁY',
      'NGƯỜI GIỮ',
      'LOẠI LICENSE',
      'START DATE',
      'END DATE',
      'STATUS',
      'COST',
      'SERIAL',
      'BRAND',
      'NOTE',
    ]);
    const esc = (v: string | null) => (v == null ? '' : escapeCellDisplay(v));
    // rows đã ORDER BY license_name → gom nhóm liên tiếp, cột A chỉ ghi ở dòng đầu nhóm rồi
    // merge dọc để "1 phần mềm — nhiều bản" nhìn gọn.
    let excelRow = 1; // dòng 1 là header
    let g = 0;
    while (g < rows.length) {
      const name = rows[g].licenseName;
      let gEnd = g;
      while (gEnd < rows.length && rows[gEnd].licenseName === name) gEnd++;
      const firstRow = excelRow + 1;
      for (let k = g; k < gEnd; k++) {
        const r = rows[k];
        sheet.addRow([
          k === g ? esc(r.licenseName) : '',
          esc(r.installedOnCode),
          esc(r.holderName ?? r.holderSub),
          esc(r.licenseType),
          r.startDate ?? '',
          r.endDate ?? '',
          esc(r.status),
          r.cost ?? '',
          esc(r.serial),
          esc(r.brand),
          esc(r.note),
        ]);
        excelRow++;
      }
      if (gEnd - g > 1) sheet.mergeCells(firstRow, 1, excelRow, 1);
      g = gEnd;
    }
    sheet.getColumn(1).alignment = { vertical: 'top' };
    await this.audit.append({
      actor: actorSub,
      action: 'assets.export_software',
      objectType: 'assets_export',
      detail: { filters: this.filterDetail(query), rowCount: rows.length },
    });
    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      rowCount: rows.length,
    };
  }

  /**
   * Sheet phụ "Phần mềm" cho export Tài sản: NỞ cột SOFTWARE gộp thành mỗi dòng = 1 cặp
   * (máy × phần mềm) → Excel lọc/đếm/pivot theo tên phần mềm dễ dàng. Lấy theo đúng tập máy
   * đã xuất (rows) nên tôn trọng bộ lọc; bỏ qua nếu không máy nào có phần mềm.
   */
  private async addSoftwareBreakdownSheet(
    workbook: ExcelJS.Workbook,
    rows: {
      id: string;
      code: string | null;
      type: string;
      assignedUserName: string | null;
      assignedUserSub: string | null;
      department: string | null;
    }[],
  ): Promise<void> {
    if (!rows.length) return;
    const swRows = await this.db
      .select({
        hostId: assetsTable.installedOnAssetId,
        licenseName: assetsTable.licenseName,
      })
      .from(assetsTable)
      .where(
        and(
          eq(assetsTable.type, 'software'),
          inArray(
            assetsTable.installedOnAssetId,
            rows.map((r) => r.id),
          ),
          sql`${assetsTable.status} <> 'disposed'`,
          sql`${assetsTable.purgedAt} IS NULL`,
          sql`${assetsTable.licenseName} IS NOT NULL`,
        ),
      );
    if (!swRows.length) return;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const flat = swRows
      .map((s) => ({ host: byId.get(s.hostId ?? ''), name: s.licenseName }))
      .filter((x): x is { host: (typeof rows)[number]; name: string } =>
        Boolean(x.host && x.name),
      )
      .sort(
        (a, b) =>
          (a.host.code ?? '').localeCompare(b.host.code ?? '') ||
          a.name.localeCompare(b.name),
      );
    const sheet = workbook.addWorksheet('Phan mem');
    sheet.addRow(['CODE', 'TYPE', 'USER', 'DEPARTMENT', 'SOFTWARE']);
    const esc = (v: string | null) => (v == null ? '' : escapeCellDisplay(v));
    for (const x of flat) {
      sheet.addRow([
        esc(x.host.code),
        esc(x.host.type),
        esc(x.host.assignedUserName ?? x.host.assignedUserSub),
        esc(x.host.department),
        esc(x.name),
      ]);
    }
  }

  private assertNotTooLarge(n: number): void {
    if (n > 10_000) {
      throw new BadRequestException({
        code: 'EXPORT_TOO_LARGE',
        message: 'Quá 10.000 dòng — thu hẹp bộ lọc rồi export lại.',
      });
    }
  }

  private filterDetail(query: ExportQuery) {
    return {
      search: query.search ?? null,
      type: query.type ?? null,
      status: query.status ?? null,
      expiring: query.expiring ?? false,
      selectedIds: query.ids?.length ?? 0,
    };
  }
}
