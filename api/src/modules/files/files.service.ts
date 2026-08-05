import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadStream } from 'node:fs';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { detectFileType, SIZE_LIMITS } from './file-validation';
import type { FileKind } from './file-validation';
import { filesTable } from './files.schema';

/** Thư mục lưu file trên volume (AD-6) — tên file = uuid, không đoán được. */
function storageDir(): string {
  const dir = process.env.FILE_STORAGE_DIR;
  if (!dir) {
    throw new Error('FILE_STORAGE_DIR chưa đặt — kiểm tra docker-compose/env.');
  }
  return dir;
}

@Injectable()
export class FilesService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
  ) {}

  /**
   * Lưu file (2.8, AC 1): whitelist magic-byte + trần theo loại; ghi đĩa TRƯỚC,
   * row SAU — nếu insert fail thì xóa file mồ côi (đĩa không có row = rác vô hại,
   * row không có đĩa = download 500).
   */
  async save(
    buffer: Buffer,
    originalName: string,
    expectedKind: FileKind,
    actorSub: string,
  ) {
    const detected = detectFileType(buffer, originalName);
    if (!detected) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_FILE',
        message:
          'Định dạng không được hỗ trợ — chỉ nhận jpg/png/webp (ảnh) và pdf/xlsx (biên bản).',
      });
    }
    if (detected.kind !== expectedKind) {
      throw new BadRequestException({
        code: 'WRONG_FILE_KIND',
        message:
          expectedKind === 'image'
            ? 'Chỗ này chỉ nhận ảnh (jpg/png/webp).'
            : 'Chỗ này chỉ nhận biên bản (pdf/xlsx).',
      });
    }
    const limit = SIZE_LIMITS[detected.kind];
    if (buffer.length > limit) {
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: `File vượt trần ${Math.round(limit / 1024 / 1024)}MB.`,
      });
    }
    const dir = storageDir();
    await mkdir(dir, { recursive: true });
    // id sinh trước để đặt tên file = id (uuid) — insert row sau khi ghi đĩa thành công
    const id = randomUUID();
    await writeFile(join(dir, id), buffer);
    try {
      const rows = await this.db
        .insert(filesTable)
        .values({
          id,
          originalName,
          mime: detected.mime,
          kind: detected.kind,
          sizeBytes: buffer.length,
          uploadedBy: actorSub,
        })
        .returning();
      await this.audit.append({
        actor: actorSub,
        action: 'files.upload',
        objectType: 'file',
        objectId: id,
        detail: {
          originalName,
          mime: detected.mime,
          sizeBytes: buffer.length,
        },
      });
      return rows[0];
    } catch (error) {
      await unlink(join(dir, id)).catch(() => undefined);
      throw error;
    }
  }

  /** Metadata + stream để download — controller set header attachment (AC 2). */
  async openForDownload(id: string, actorSub: string) {
    const rows = await this.db
      .select()
      .from(filesTable)
      .where(eq(filesTable.id, id));
    const meta = rows[0];
    if (!meta) {
      throw new NotFoundException({
        code: 'FILE_NOT_FOUND',
        message: 'Không tìm thấy file này.',
      });
    }
    // FR-43: kênh exfil phải có vết — ghi TRƯỚC khi stream (best-effort append,
    // chặn tải vì audit hiccup là quá tay cho biên bản kiểm kê nội bộ)
    await this.audit.append({
      actor: actorSub,
      action: 'files.download',
      objectType: 'file',
      objectId: id,
      detail: { originalName: meta.originalName },
    });
    const stream: ReadStream = createReadStream(join(storageDir(), id));
    return { meta, stream };
  }
}
