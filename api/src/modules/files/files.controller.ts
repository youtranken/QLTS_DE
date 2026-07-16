import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { IsIn } from 'class-validator';
import type { Response } from 'express';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { FilesService } from './files.service';
import { MULTER_LIMIT } from './file-validation';
import type { FileKind } from './file-validation';

class UploadFileDto {
  @IsIn(['image', 'document'])
  kind!: FileKind;
}

function requireSub(req: AuthedRequest): string {
  if (!req.user) {
    throw new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: 'Chưa đăng nhập.',
    });
  }
  return req.user.sub;
}

function requireFile(
  file: Express.Multer.File | undefined,
): Express.Multer.File {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new BadRequestException({
      code: 'FILE_REQUIRED',
      message: 'Thiếu file upload (field "file").',
    });
  }
  return file;
}

/** multer/busboy đọc filename multipart theo latin1 — tên tiếng Việt thành mojibake nếu không decode lại UTF-8. */
function decodeOriginalName(name: string): string {
  return Buffer.from(name, 'latin1').toString('utf8');
}

/**
 * Sanitize tên file cho Content-Disposition — chống header injection;
 * tên gốc unicode gửi qua filename* (RFC 5987).
 */
function contentDisposition(originalName: string): string {
  const fallback =
    originalName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_') ||
    'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(originalName)}`;
}

/** Module file dùng chung (2.8) — CHỈ Admin/SA (NFR-8); member 403 từ RolesGuard. */
@Controller('admin/files')
@Roles('sa', 'admin')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  // upload 20MB buffer RAM — siết 20 req/phút/user (epic review)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: MULTER_LIMIT }))
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadFileDto,
    @Req() req: AuthedRequest,
  ) {
    const f = requireFile(file);
    return this.files.save(
      f.buffer,
      decodeOriginalName(f.originalname),
      body.kind,
      requireSub(req),
    );
  }

  /** Download CHỈ qua đây (AC 2): attachment + octet-stream, audit trước khi stream. */
  @Get(':id/download')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    const { meta, stream } = await this.files.openForDownload(
      id,
      requireSub(req),
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(meta.sizeBytes));
    res.setHeader('Content-Disposition', contentDisposition(meta.originalName));
    // belt-and-suspenders chống MIME-sniff (review 2.8) — attachment đã là chốt chính
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // file mất trên đĩa (row có, đĩa không) → 500 JSON sạch; PHẢI gỡ Content-Length
    // đã set (body rỗng + length cũ làm client chờ/abort — epic review test bắt được)
    stream.on('error', () => {
      if (!res.headersSent) {
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Disposition');
        res.status(500).json({
          statusCode: 500,
          code: 'FILE_MISSING',
          message: 'File không còn trên ổ lưu trữ — báo quản trị hệ thống.',
        });
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  }
}
