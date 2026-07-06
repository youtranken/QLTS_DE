import * as ExcelJS from 'exceljs';
import {
  assertZipSafe,
  escapeCellDisplay,
  mapStatus,
  parseCostCell,
  parseDateCell,
  parseWorkbook,
} from './import-parser';

const HEADERS = [
  'NO.',
  'USER',
  'CODE',
  'ASSET TYPE',
  'CONFIGURATION',
  'COST',
  'START DATE',
  'END DATE',
  'PLACE',
  'STATUS',
  'NOTE',
];

async function buildXlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('So tai san');
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('escapeCellDisplay (NFR-10)', () => {
  it("ô bắt đầu = + - @ TAB CR → prefix '", () => {
    expect(escapeCellDisplay('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(escapeCellDisplay('+84 90')).toBe("'+84 90");
    expect(escapeCellDisplay('-1')).toBe("'-1");
    expect(escapeCellDisplay('@domain')).toBe("'@domain");
    expect(escapeCellDisplay('\tx')).toBe("'\tx");
    expect(escapeCellDisplay('\rx')).toBe("'\rx");
  });

  it('giá trị thường giữ nguyên', () => {
    expect(escapeCellDisplay('Laptop Dell')).toBe('Laptop Dell');
    expect(escapeCellDisplay('3-AA-CT-0042')).toBe('3-AA-CT-0042');
  });
});

describe('mapStatus — vi/en, có dấu/không dấu', () => {
  it('map đúng 3 trạng thái + rỗng = in_use', () => {
    expect(mapStatus('Đang sử dụng')).toBe('in_use');
    expect(mapStatus('dang dung')).toBe('in_use');
    expect(mapStatus('')).toBe('in_use');
    expect(mapStatus('Sửa chữa')).toBe('locked_repair');
    expect(mapStatus('Hỏng')).toBe('locked_repair');
    expect(mapStatus('Thanh lý')).toBe('disposed');
    expect(mapStatus('THANH LY')).toBe('disposed');
  });

  it('trạng thái lạ → null (dòng lỗi)', () => {
    expect(mapStatus('đang bay')).toBeNull();
  });
});

describe('parseDateCell / parseCostCell', () => {
  it('nhận Date, yyyy-mm-dd, dd/mm/yyyy; sai → undefined; trống → null', () => {
    expect(parseDateCell(new Date(Date.UTC(2026, 0, 15)))).toBe('2026-01-15');
    expect(parseDateCell('2026-01-15')).toBe('2026-01-15');
    expect(parseDateCell('15/01/2026')).toBe('2026-01-15');
    expect(parseDateCell('15-1-2026')).toBe('2026-01-15');
    expect(parseDateCell('')).toBeNull();
    expect(parseDateCell(null)).toBeNull();
    expect(parseDateCell('40/13/2026')).toBeUndefined();
    expect(parseDateCell('ngày nào đó')).toBeUndefined();
  });

  it('cost: số, chuỗi có ngăn nghìn; âm/chữ → undefined; trống → null', () => {
    expect(parseCostCell(25000000)).toBe(25000000);
    expect(parseCostCell('25,000,000')).toBe(25000000);
    expect(parseCostCell('25.000.000')).toBe(25000000);
    expect(parseCostCell('')).toBeNull();
    expect(parseCostCell('hai lăm triệu')).toBeUndefined();
    expect(parseCostCell(-5)).toBeUndefined();
  });
});

describe('assertZipSafe — chống zip-bomb (AC 1)', () => {
  it('xlsx thật đi qua; buffer rác → UNSUPPORTED_FILE', async () => {
    const buf = await buildXlsx([[1, 'A', 'X-1', 'laptop']]);
    expect(() => assertZipSafe(buf)).not.toThrow();
    expect(() =>
      assertZipSafe(Buffer.from('PK\x03\x04khong phai zip that')),
    ).toThrow(/zip/);
  });
});

describe('parseWorkbook — end-to-end trên buffer thật', () => {
  it('đọc đúng dòng, bắt lỗi thiếu CODE/date/cost/status, trùng mã trong file', async () => {
    const buf = await buildXlsx([
      [
        1,
        'Nguyễn Văn A',
        'M-01',
        'laptop',
        'i5/8GB',
        15000000,
        '15/01/2026',
        '',
        'Tầng 3',
        'Đang sử dụng',
        'ghi chú',
      ],
      [2, '', '', 'desktop', '', '', '', '', '', '', ''], // thiếu CODE
      [
        3,
        'B',
        'M-03',
        'monitor',
        '',
        'ba trieu',
        'hôm qua',
        '',
        '',
        'bay màu',
        '',
      ], // cost+date+status lỗi
      [4, '', 'M-01', 'laptop', '', '', '', '', '', '', ''], // trùng mã dòng 2 (excel row 2)
      [5, 'C', '=HACK()', 'software', '', '', '', '31/12/2026', '', '', '=cmd'],
    ]);
    const rows = await parseWorkbook(buf);
    expect(rows).toHaveLength(5);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      code: 'M-01',
      type: 'laptop',
      cost: 15000000,
      startDate: '2026-01-15',
      floor: 'Tầng 3',
      status: 'in_use',
    });
    expect(rows[1].errors.join(' ')).toContain('CODE');
    expect(rows[2].errors.join(' ')).toContain('COST');
    expect(rows[2].errors.join(' ')).toContain('START DATE');
    expect(rows[2].errors.join(' ')).toContain('STATUS');
    expect(rows[3].errors.join(' ')).toContain('trùng');
    // software: type chuẩn hóa; display escape NFR-10
    expect(rows[4].type).toBe('software');
    expect(rows[4].display.code).toBe("'=HACK()");
    expect(rows[4].display.note).toBe("'=cmd");
  });

  it('không có header CODE/USER → HEADER_NOT_FOUND', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('x').addRow(['cot', 'la', 'lam']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseWorkbook(buf)).rejects.toThrow(/tiêu đề/);
  });
});
