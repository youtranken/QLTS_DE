import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import * as ExcelJS from 'exceljs';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { SystemConfigService } from '../config/system-config.service';
import { escapeCellDisplay } from './import-parser';

export type EolMachine = {
  id: string;
  code: string | null;
  type: string;
  configuration: string | null;
  startDate: string | null;
  ageYears: number;
  eolDate: string;
  /** eolDate − hôm nay (VN). <= 0 nghĩa là ĐÃ quá tuổi. */
  daysToEol: number;
  assignedUserName: string | null;
  /** Ngày đã đưa vào digest cảnh báo EOL (YYYY-MM-DD). null = chưa báo lần nào. */
  eolNotifiedAt: string | null;
};

export type EolSoftware = {
  id: string;
  licenseName: string | null;
  installedOnCode: string | null;
  endDate: string | null;
  /** endDate − hôm nay (VN). < 0 nghĩa là ĐÃ hết hạn. */
  daysLeft: number;
  assignedUserName: string | null;
};

/** Bộ lọc EOL (từ query). Ngày dạng YYYY-MM-DD. */
export interface EolFilter {
  /** Máy: chỉ hiện máy tuổi >= minYears. Mặc định = asset_lifespan_years. */
  minYears?: number;
  startFrom?: string;
  startTo?: string;
  /** Phần mềm: end_date trong [endFrom, endTo]. Rỗng → cửa sổ cảnh báo mặc định. */
  endFrom?: string;
  endTo?: string;
}

const TODAY_VN = sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
const isDate = (v?: string): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Cảnh báo EOL (End of Life) — 2 nhóm việc cho admin:
 *  1) Máy đủ/gần đủ tuổi thọ (lọc theo tuổi + khoảng ngày dùng) → nên thanh lý.
 *  2) License THUÊ BAO (term) sắp/đã hết hạn (lọc theo khoảng ngày hết hạn).
 * Read-only + export Excel; thanh lý đi qua endpoint dispose sẵn có (FE chọn nhiều → loop).
 */
@Injectable()
export class EolService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly config: SystemConfigService,
  ) {}

  private async queryMachines(
    filter: EolFilter,
    lifespanYears: number,
  ): Promise<EolMachine[]> {
    const minYears = Math.min(50, Math.max(1, filter.minYears ?? lifespanYears));
    const conds: SQL[] = [
      sql`a.type <> 'software' AND a.status <> 'disposed' AND a.purged_at IS NULL`,
      sql`a.start_date IS NOT NULL`,
      // tuổi >= minYears. Viết SARGABLE (không bọc cột start_date trong hàm) để dùng được index:
      // start_date + N năm <= today  ⟺  start_date <= today - N năm.
      sql`a.start_date <= (${TODAY_VN} - make_interval(years => ${minYears}::int))::date`,
    ];
    if (isDate(filter.startFrom)) conds.push(sql`a.start_date >= ${filter.startFrom}`);
    if (isDate(filter.startTo)) conds.push(sql`a.start_date <= ${filter.startTo}`);
    const where = sql.join(conds, sql` AND `);
    const rows = await this.db.execute<EolMachine>(sql`
      SELECT a.id, a.code, a.type, a.configuration,
             a.start_date::text AS "startDate",
             date_part('year', age(${TODAY_VN}, a.start_date))::int AS "ageYears",
             (a.start_date + make_interval(years => ${lifespanYears}::int))::date::text AS "eolDate",
             ((a.start_date + make_interval(years => ${lifespanYears}::int))::date - ${TODAY_VN})::int AS "daysToEol",
             (a.eol_notified_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS "eolNotifiedAt",
             u.full_name AS "assignedUserName"
      FROM assets a
      LEFT JOIN users u ON u.sub = a.assigned_user_sub
      WHERE ${where}
      ORDER BY "daysToEol" ASC, a.code ASC
    `);
    return rows.rows;
  }

  private async querySoftware(
    filter: EolFilter,
    warningDays: number,
  ): Promise<EolSoftware[]> {
    const conds: SQL[] = [
      sql`a.type = 'software' AND a.status <> 'disposed' AND a.purged_at IS NULL`,
      sql`a.license_type = 'term' AND a.end_date IS NOT NULL`,
    ];
    if (isDate(filter.endFrom) || isDate(filter.endTo)) {
      if (isDate(filter.endFrom)) conds.push(sql`a.end_date >= ${filter.endFrom}`);
      if (isDate(filter.endTo)) conds.push(sql`a.end_date <= ${filter.endTo}`);
    } else {
      conds.push(sql`a.end_date <= (${TODAY_VN} + ${warningDays}::int)`);
    }
    const where = sql.join(conds, sql` AND `);
    const rows = await this.db.execute<EolSoftware>(sql`
      SELECT a.id, a.license_name AS "licenseName", host.code AS "installedOnCode",
             a.end_date::text AS "endDate",
             (a.end_date - ${TODAY_VN})::int AS "daysLeft",
             hu.full_name AS "assignedUserName"
      FROM assets a
      LEFT JOIN assets host ON host.id = a.installed_on_asset_id
      LEFT JOIN users hu ON hu.sub = host.assigned_user_sub
      WHERE ${where}
      ORDER BY "daysLeft" ASC, a.license_name ASC
    `);
    return rows.rows;
  }

  async list(filter: EolFilter = {}): Promise<{
    lifespanYears: number;
    warningDays: number;
    machines: EolMachine[];
    software: EolSoftware[];
  }> {
    const lifespanYears = await this.config.getAssetLifespanYears();
    const warningDays = await this.config.getLicenseWarningDays();
    const [machines, software] = await Promise.all([
      this.queryMachines(filter, lifespanYears),
      this.querySoftware(filter, warningDays),
    ]);
    return { lifespanYears, warningDays, machines, software };
  }

  private esc(v: string | null): string {
    return v == null ? '' : escapeCellDisplay(v);
  }

  async exportMachines(filter: EolFilter): Promise<Buffer> {
    const lifespanYears = await this.config.getAssetLifespanYears();
    const rows = await this.queryMachines(filter, lifespanYears);
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('May-EOL');
    sheet.addRow([
      'CODE', 'TYPE', 'CONFIGURATION', 'START DATE', 'IN USE (YEARS)',
      'EXPIRY DATE', 'DAYS LEFT', 'USER',
    ]);
    for (const r of rows) {
      sheet.addRow([
        this.esc(r.code), this.esc(r.type), this.esc(r.configuration),
        r.startDate ?? '', r.ageYears, r.eolDate, r.daysToEol,
        this.esc(r.assignedUserName),
      ]);
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async exportSoftware(filter: EolFilter): Promise<Buffer> {
    const warningDays = await this.config.getLicenseWarningDays();
    const rows = await this.querySoftware(filter, warningDays);
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('License-EOL');
    sheet.addRow(['LICENSE NAME', 'INSTALLED ON', 'END DATE', 'DAYS LEFT', 'USER']);
    for (const r of rows) {
      sheet.addRow([
        this.esc(r.licenseName), this.esc(r.installedOnCode),
        r.endDate ?? '', r.daysLeft, this.esc(r.assignedUserName),
      ]);
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
}
