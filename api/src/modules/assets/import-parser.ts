import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

/**
 * Parse sổ Excel cũ (2.9, FR-40) — cấu trúc cột: NO., USER, CODE, ASSET TYPE,
 * CONFIGURATION, COST, START DATE, END DATE, PLACE, STATUS, NOTE.
 */

export const MAX_ROWS = 5000;
/**
 * Chống zip-bomb (party phiên 7): tổng kích thước GIẢI NÉN + số entry trong zip.
 * 15MB đủ dư cho 5000 dòng (~10-15MB); 50MB làm exceljs spike ~300MB RSS →
 * OOM với mem_limit 384m (repro review 2.9).
 */
export const MAX_UNCOMPRESSED = 15 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 200;

export interface ImportRow {
  /** Số dòng THẬT trong file Excel (1-based) — báo lỗi trỏ đúng dòng. */
  rowNumber: number;
  user: string | null;
  code: string | null;
  type: string | null;
  configuration: string | null;
  cost: number | null;
  startDate: string | null;
  endDate: string | null;
  floor: string | null;
  status: string | null;
  note: string | null;
  errors: string[];
  /** Giá trị hiển thị đã escape NFR-10 — FE render nguyên văn. */
  display: Record<string, string>;
}

/** NFR-10: ô bắt đầu = + - @ TAB CR → prefix ' để không bao giờ thực thi. */
export function escapeCellDisplay(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

/**
 * Đọc tổng uncompressedSize từ central directory của zip (xlsx = zip) —
 * KHÔNG giải nén; chặn zip-bomb trước khi đưa vào exceljs.
 */
export function assertZipSafe(buf: Buffer): void {
  // End of Central Directory: signature 0x06054b50, tìm ngược từ cuối (comment ≤64KB)
  const maxScan = Math.min(buf.length, 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - maxScan; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new BadRequestException({
      code: 'UNSUPPORTED_FILE',
      message: 'File xlsx không hợp lệ (không đọc được cấu trúc zip).',
    });
  }
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new BadRequestException({
      code: 'ZIP_TOO_COMPLEX',
      message: `File chứa quá nhiều entry (${entryCount} > ${MAX_ZIP_ENTRIES}).`,
    });
  }
  // Duyệt central directory records (signature 0x02014b50)
  let pos = cdOffset;
  let totalUncompressed = 0;
  for (let n = 0; n < entryCount; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_FILE',
        message: 'File xlsx không hợp lệ (central directory hỏng).',
      });
    }
    totalUncompressed += buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (totalUncompressed > MAX_UNCOMPRESSED) {
    throw new BadRequestException({
      code: 'ZIP_BOMB',
      message: `Kích thước giải nén ${Math.round(totalUncompressed / 1024 / 1024)}MB vượt trần 50MB.`,
    });
  }
}

/** Map STATUS sổ cũ (vi/en, có dấu/không dấu) → giá trị hệ thống; null = không nhận diện. */
export function mapStatus(raw: string): string | null {
  const norm = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .trim()
    .toLowerCase();
  if (norm === '') return 'in_use';
  if (
    [
      'dang dung',
      'dang su dung',
      'in use',
      'in_use',
      'active',
      'su dung',
    ].includes(norm)
  ) {
    return 'in_use';
  }
  if (
    [
      'khoa',
      'sua chua',
      'khoa sua chua',
      'dang sua',
      'repair',
      'hong',
      'locked',
      'locked_repair',
    ].includes(norm)
  ) {
    return 'locked_repair';
  }
  if (['thanh ly', 'da thanh ly', 'disposed', 'huy'].includes(norm)) {
    return 'disposed';
  }
  return null;
}

/** Parse ngày: Date (cell Excel), 'yyyy-mm-dd', 'dd/mm/yyyy', 'dd-mm-yyyy'; null nếu trống; undefined = lỗi. */
export function parseDateCell(value: unknown): string | null | undefined {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    // exceljs trả Date UTC cho date cell — lấy phần ngày theo UTC
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const s = String(value).trim();
  if (s === '') return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return toIsoDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return toIsoDate(+m[3], +m[2], +m[1]);
  return undefined;
}

function toIsoDate(y: number, mo: number, d: number): string | undefined {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d)
    return undefined;
  return date.toISOString().slice(0, 10);
}

/** Parse giá: number cell hoặc chuỗi số (bỏ dấu phẩy/chấm ngăn nghìn kiểu '25,000,000'). */
export function parseCostCell(value: unknown): number | null | undefined {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (s === '') return null;
  // CHỈ nhận số nguyên hoặc ngăn-nghìn đúng nhóm 3 ('25,000,000') —
  // '25.5' KHÔNG được lặng lẽ thành 255 (review 2.9)
  if (!/^\d+$/.test(s) && !/^\d{1,3}([,. ]\d{3})+$/.test(s)) return undefined;
  const n = Number(s.replace(/[,. ]/g, ''));
  return Number.isSafeInteger(n) ? n : undefined;
}

const HEADERS: Record<string, keyof ImportRow | 'no'> = {
  NO: 'no',
  USER: 'user',
  CODE: 'code',
  'ASSET TYPE': 'type',
  CONFIGURATION: 'configuration',
  COST: 'cost',
  'START DATE': 'startDate',
  'END DATE': 'endDate',
  PLACE: 'floor',
  STATUS: 'status',
  NOTE: 'note',
};

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    // rich text / formula / hyperlink — lấy phần text/result, KHÔNG bao giờ thực thi
    const v = value as {
      richText?: Array<{ text: string }>;
      text?: string;
      result?: unknown;
    };
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (typeof v.text === 'string') return v.text;
    if (typeof v.result === 'string' || typeof v.result === 'number') {
      return String(v.result);
    }
    return '';
  }
  return String(value);
}

/** Đọc buffer xlsx → danh sách dòng đã validate cục bộ (chưa đụng DB). */
export async function parseWorkbook(buf: Buffer): Promise<ImportRow[]> {
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
  // Tìm header row trong 10 dòng đầu: phải chứa CODE và USER
  let headerRowIdx = -1;
  const colMap = new Map<number, keyof ImportRow | 'no'>();
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    const found = new Map<number, keyof ImportRow | 'no'>();
    row.eachCell((cell, col) => {
      const key = cellText(cell.value).trim().toUpperCase().replace(/\.$/, '');
      if (key in HEADERS) found.set(col, HEADERS[key]);
    });
    if (
      [...found.values()].includes('code') &&
      [...found.values()].includes('user')
    ) {
      headerRowIdx = r;
      found.forEach((v, k) => colMap.set(k, v));
      break;
    }
  }
  if (headerRowIdx < 0) {
    throw new BadRequestException({
      code: 'HEADER_NOT_FOUND',
      message:
        'Không tìm thấy dòng tiêu đề (cần các cột CODE, USER… theo cấu trúc sổ cũ).',
    });
  }

  const rows: ImportRow[] = [];
  const seenCodes = new Map<string, number>();
  for (let r = headerRowIdx + 1; r <= sheet.rowCount; r++) {
    const excelRow = sheet.getRow(r);
    const raw: Partial<Record<keyof ImportRow | 'no', string>> = {};
    colMap.forEach((field, col) => {
      raw[field] = cellText(excelRow.getCell(col).value).trim();
    });
    const isEmpty = Object.entries(raw).every(([k, v]) => k === 'no' || !v);
    if (isEmpty) continue;

    const errors: string[] = [];
    const code = raw.code || null;
    const type = raw.type || null;
    const isSoftwareRow = (type ?? '').trim().toLowerCase() === 'software';
    if (!type) errors.push('Thiếu ASSET TYPE (loại bắt buộc).');
    // sw-license-model: MÁY bắt buộc CODE; PHẦN MỀM định danh bằng license_name (cột
    // CONFIGURATION) — không cần mã, nhưng phải có tên (CONFIGURATION hoặc CODE cũ).
    if (!isSoftwareRow && !code) {
      errors.push('Thiếu CODE (mã tài sản bắt buộc).');
    }
    if (isSoftwareRow && !raw.configuration && !code) {
      errors.push('Thiếu tên license — điền cột CONFIGURATION cho phần mềm.');
    }
    // Trùng mã chỉ xét cho MÁY (phần mềm không còn mã, không tham gia unique code).
    if (!isSoftwareRow && code) {
      const dup = seenCodes.get(code);
      if (dup !== undefined) {
        errors.push(`Mã trùng với dòng ${dup} trong file.`);
      } else {
        seenCodes.set(code, r);
      }
    }
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
    const isSoftware = isSoftwareRow;
    // F3 (epic review): lock/unlock chỉ dành cho MÁY (2.6) — software import vào
    // locked_repair sẽ kẹt vĩnh viễn (unlock trả NOT_MACHINE)
    if (isSoftware && status === 'locked_repair') {
      errors.push(
        'Software không có trạng thái "khóa sửa chữa" — chỉ nhận đang dùng hoặc thanh lý.',
      );
    }

    const display: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'no') continue;
      display[k] = escapeCellDisplay(v ?? '');
    }

    rows.push({
      rowNumber: r,
      user: raw.user || null,
      code,
      type: isSoftware ? 'software' : type,
      configuration: raw.configuration || null,
      cost: cost === undefined ? null : cost,
      startDate: startDate === undefined ? null : startDate,
      endDate: endDate === undefined ? null : endDate,
      floor: raw.floor || null,
      status: status ?? 'in_use',
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
