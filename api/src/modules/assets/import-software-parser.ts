import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import {
  assertZipSafe,
  cellText,
  escapeCellDisplay,
  MAX_ROWS,
  mapStatus,
  parseCostCell,
  parseDateCell,
} from './import-parser';

/**
 * Parse file Excel PHẦN MỀM (VĐ4) — khớp cột Export phần mềm (asset-export.service):
 * TÊN PHẦN MỀM | MÁY | NGƯỜI GIỮ | LOẠI LICENSE | START DATE | END DATE | STATUS | COST |
 * SERIAL | BRAND | NOTE. Cột A gộp ô theo nhóm license → điền-xuống (fill-down) tên khi trống.
 * NGƯỜI GIỮ chỉ tham chiếu (holder derive theo máy) — KHÔNG import.
 */
export interface SoftwareImportRow {
  rowNumber: number;
  licenseName: string | null;
  installedOnCode: string | null;
  licenseType: string;
  startDate: string | null;
  endDate: string | null;
  status: string;
  cost: number | null;
  serial: string | null;
  brand: string | null;
  note: string | null;
  errors: string[];
  display: Record<string, string>;
}

type Field = keyof SoftwareImportRow | 'holder';

const HEADERS: Record<string, Field> = {
  'TÊN PHẦN MỀM': 'licenseName',
  MÁY: 'installedOnCode',
  'NGƯỜI GIỮ': 'holder',
  'LOẠI LICENSE': 'licenseType',
  'START DATE': 'startDate',
  'END DATE': 'endDate',
  STATUS: 'status',
  COST: 'cost',
  SERIAL: 'serial',
  BRAND: 'brand',
  NOTE: 'note',
};

/** term/perpetual từ cột LOẠI LICENSE; trống → suy từ END DATE (có hạn = term). */
function normLicenseType(raw: string, endDate: string | null): string {
  const n = raw.trim().toLowerCase();
  if (n === 'term' || n === 'perpetual') return n;
  return endDate ? 'term' : 'perpetual';
}

export async function parseSoftwareWorkbook(
  buf: Buffer,
): Promise<SoftwareImportRow[]> {
  assertZipSafe(buf);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buf as unknown as ExcelJS.Buffer);
  } catch {
    throw new BadRequestException({
      code: 'UNSUPPORTED_FILE',
      message: 'Không đọc được file xlsx — kiểm tra lại định dạng.',
    });
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new BadRequestException({
      code: 'EMPTY_WORKBOOK',
      message: 'File không có sheet nào.',
    });
  }
  if (sheet.rowCount > MAX_ROWS + 10) {
    throw new BadRequestException({
      code: 'TOO_MANY_ROWS',
      message: `File quá ${MAX_ROWS} dòng — tách nhỏ rồi import từng phần.`,
    });
  }

  // Tìm header trong 10 dòng đầu: phải có TÊN PHẦN MỀM và LOẠI LICENSE.
  let headerRowIdx = -1;
  const colMap = new Map<number, Field>();
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const found = new Map<number, Field>();
    sheet.getRow(r).eachCell((cell, col) => {
      const key = cellText(cell.value).trim().toUpperCase();
      if (key in HEADERS) found.set(col, HEADERS[key]);
    });
    const fields = [...found.values()];
    if (fields.includes('licenseName') && fields.includes('licenseType')) {
      headerRowIdx = r;
      found.forEach((v, k) => colMap.set(k, v));
      break;
    }
  }
  if (headerRowIdx < 0) {
    throw new BadRequestException({
      code: 'HEADER_NOT_FOUND',
      message:
        'Không tìm thấy tiêu đề — cần các cột TÊN PHẦN MỀM, LOẠI LICENSE… (như file Export phần mềm).',
    });
  }

  const rows: SoftwareImportRow[] = [];
  let lastName: string | null = null; // fill-down cột A (ô gộp theo nhóm)
  for (let r = headerRowIdx + 1; r <= sheet.rowCount; r++) {
    const excelRow = sheet.getRow(r);
    const raw: Partial<Record<Field, string>> = {};
    colMap.forEach((field, col) => {
      raw[field] = cellText(excelRow.getCell(col).value).trim();
    });
    // Dòng rỗng hoàn toàn (bỏ cột A đã fill-down): bỏ qua.
    const meaningful = (
      [
        'installedOnCode',
        'licenseType',
        'startDate',
        'endDate',
        'status',
        'cost',
        'serial',
        'brand',
        'note',
      ] as Field[]
    ).some((f) => raw[f]);
    if (!raw.licenseName && !meaningful) continue;

    const name = raw.licenseName || lastName;
    if (raw.licenseName) lastName = raw.licenseName;

    const errors: string[] = [];
    if (!name) errors.push('Thiếu TÊN PHẦN MỀM.');
    const cost = parseCostCell(raw.cost);
    if (cost === undefined) errors.push(`COST không phải số: "${raw.cost}".`);
    const startDate = parseDateCell(raw.startDate);
    if (startDate === undefined) {
      errors.push(`START DATE không parse được: "${raw.startDate}".`);
    }
    const endDate = parseDateCell(raw.endDate);
    if (endDate === undefined) {
      errors.push(`END DATE không parse được: "${raw.endDate}".`);
    }
    const status = mapStatus(raw.status ?? '');
    if (status === null) {
      errors.push(`STATUS không nhận diện: "${raw.status}".`);
    }
    if (status === 'locked_repair') {
      errors.push('Phần mềm không có trạng thái "khóa sửa chữa".');
    }

    const display: Record<string, string> = {};
    display.licenseName = escapeCellDisplay(name ?? '');
    for (const f of [
      'installedOnCode',
      'licenseType',
      'startDate',
      'endDate',
      'status',
      'cost',
      'serial',
      'brand',
      'note',
    ] as Field[]) {
      display[f] = escapeCellDisplay(raw[f] ?? '');
    }

    rows.push({
      rowNumber: r,
      licenseName: name,
      installedOnCode: raw.installedOnCode || null,
      licenseType: normLicenseType(
        raw.licenseType ?? '',
        endDate === undefined ? null : endDate,
      ),
      startDate: startDate === undefined ? null : startDate,
      endDate: endDate === undefined ? null : endDate,
      status: status ?? 'in_use',
      cost: cost === undefined ? null : cost,
      serial: raw.serial || null,
      brand: raw.brand || null,
      note: raw.note || null,
      errors,
      display,
    });
    if (rows.length > MAX_ROWS) {
      throw new BadRequestException({
        code: 'TOO_MANY_ROWS',
        message: `File quá ${MAX_ROWS} dòng dữ liệu — tách nhỏ rồi import từng phần.`,
      });
    }
  }
  return rows;
}
