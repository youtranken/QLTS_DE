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
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Response } from 'express';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { FilesService } from './files.service';
import type { FileKind } from './file-validation';

class UploadFileDto {
  @IsIn(['image', 'document'])
  kind!: FileKind;
}

class CreateRoundDto {
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;
}

/** Trần multer đặt bằng trần lớn nhất (20MB) — trần theo loại check trong service. */
const MULTER_LIMIT = { fileSize: 20 * 1024 * 1024 };

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
    // file mất trên đĩa (row có, đĩa không) → 500 từ stream error, không treo response
    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  }
}

/** Đợt kiểm kê hằng năm (2.8, FR-39) — KHÔNG có endpoint xóa. */
@Controller('admin/inventory-rounds')
@Roles('sa', 'admin')
export class InventoryController {
  constructor(private readonly files: FilesService) {}

  @Post()
  createRound(@Body() body: CreateRoundDto, @Req() req: AuthedRequest) {
    return this.files.createRound(
      body.year,
      body.note?.trim() || null,
      requireSub(req),
    );
  }

  @Get()
  listRounds() {
    return this.files.listRounds();
  }

  /** Upload biên bản vào đợt — nhận pdf/xlsx lẫn ảnh chụp biên bản giấy. */
  @Post(':id/files')
  @UseInterceptors(FileInterceptor('file', { limits: MULTER_LIMIT }))
  addFile(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AuthedRequest,
  ) {
    const f = requireFile(file);
    return this.files.addFileToRound(
      id,
      f.buffer,
      decodeOriginalName(f.originalname),
      requireSub(req),
    );
  }
}
