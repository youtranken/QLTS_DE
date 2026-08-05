import { detectFileType, SIZE_LIMITS } from './file-validation';

const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const webp = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 '),
]);
const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ');
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

describe('detectFileType (2.8, NFR-9) — magic-byte, KHÔNG tin đuôi/Content-Type', () => {
  it('nhận diện đúng 5 loại whitelist', () => {
    expect(detectFileType(jpg, 'a.jpg')).toEqual({
      mime: 'image/jpeg',
      kind: 'image',
    });
    expect(detectFileType(png, 'b.png')).toEqual({
      mime: 'image/png',
      kind: 'image',
    });
    expect(detectFileType(webp, 'c.webp')).toEqual({
      mime: 'image/webp',
      kind: 'image',
    });
    expect(detectFileType(pdf, 'd.pdf')).toEqual({
      mime: 'application/pdf',
      kind: 'document',
    });
    expect(detectFileType(zip, 'e.xlsx')).toEqual({
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      kind: 'document',
    });
  });

  it('đuôi giả không qua được magic: .png chứa bytes exe → null', () => {
    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ
    expect(detectFileType(exe, 'virus.png')).toBeNull();
  });

  it('RIFF nhưng KHÔNG phải WEBP (WAVE/AVI đội lốt .webp) → null', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WAVE'),
    ]);
    expect(detectFileType(wav, 'x.webp')).toBeNull();
  });

  it('magic đúng nhưng đuôi sai cho xlsx (zip thuần/docx) → null', () => {
    expect(detectFileType(zip, 'archive.zip')).toBeNull();
    expect(detectFileType(zip, 'baocao.docx')).toBeNull();
  });

  it('đuôi hoa/thường không phân biệt cho xlsx', () => {
    expect(detectFileType(zip, 'BAOCAO.XLSX')).not.toBeNull();
  });

  it('buffer ngắn hơn magic → null, không crash', () => {
    expect(detectFileType(Buffer.from([0xff]), 'x.jpg')).toBeNull();
    expect(detectFileType(Buffer.alloc(0), 'x.png')).toBeNull();
  });

  it('trần dung lượng: ảnh 5MB, biên bản 20MB (NFR-4)', () => {
    expect(SIZE_LIMITS.image).toBe(5 * 1024 * 1024);
    expect(SIZE_LIMITS.document).toBe(20 * 1024 * 1024);
  });
});
