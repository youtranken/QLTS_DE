/**
 * Whitelist file theo MAGIC-BYTE (NFR-9) — không tin Content-Type/đuôi file
 * client gửi; đuôi chỉ dùng THÊM cho xlsx (magic zip không phân biệt được).
 */
export type FileKind = 'image' | 'document';

/** Trần dung lượng theo loại (NFR-4: ảnh ≤5MB; biên bản ≤20MB). */
export const SIZE_LIMITS: Record<FileKind, number> = {
  image: 5 * 1024 * 1024,
  document: 20 * 1024 * 1024,
};

interface DetectedType {
  mime: string;
  kind: FileKind;
  /** Đuôi bắt buộc (lowercase, gồm dấu chấm) — chỉ dùng khi magic không đủ. */
  requiredExt?: string[];
}

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/** Nhận diện loại file từ magic-byte; null = không nằm trong whitelist. */
export function detectFileType(
  buf: Buffer,
  originalName: string,
): { mime: string; kind: FileKind } | null {
  const candidates: Array<{ match: boolean } & DetectedType> = [
    {
      match: startsWith(buf, [0xff, 0xd8, 0xff]),
      mime: 'image/jpeg',
      kind: 'image',
    },
    {
      match: startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mime: 'image/png',
      kind: 'image',
    },
    {
      // RIFF....WEBP
      match:
        startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8),
      mime: 'image/webp',
      kind: 'image',
    },
    {
      match: startsWith(buf, [0x25, 0x50, 0x44, 0x46]), // %PDF
      mime: 'application/pdf',
      kind: 'document',
    },
    {
      // PK\x03\x04 = zip — xlsx là zip; magic không phân biệt docx/zip thuần
      // nên bắt buộc thêm đuôi .xlsx (whitelist NFR-9)
      match: startsWith(buf, [0x50, 0x4b, 0x03, 0x04]),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      kind: 'document',
      requiredExt: ['.xlsx'],
    },
  ];
  const lower = originalName.toLowerCase();
  for (const c of candidates) {
    if (!c.match) continue;
    if (c.requiredExt && !c.requiredExt.some((e) => lower.endsWith(e))) {
      return null;
    }
    return { mime: c.mime, kind: c.kind };
  }
  return null;
}
