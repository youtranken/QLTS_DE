import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { detectFileType } from '../files/file-validation';
import { ImportService } from './import.service';

/** Trần file import = trần biên bản 2.8 (20MB); zip-bomb guard nằm trong parser. */
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

/** Guard 2.8 TRƯỚC parse (AC 1): magic-byte phải là xlsx. */
function requireXlsx(file: Express.Multer.File | undefined): Buffer {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new BadRequestException({
      code: 'FILE_REQUIRED',
      message: 'Thiếu file upload (field "file").',
    });
  }
  const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const detected = detectFileType(file.buffer, name);
  if (
    !detected ||
    detected.mime !==
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    throw new BadRequestException({
      code: 'UNSUPPORTED_FILE',
      message: 'File import phải là .xlsx theo cấu trúc sổ cũ.',
    });
  }
  return file.buffer;
}

/** Import Excel go-live (2.9, FR-40) — CHỈ Admin/SA. */
@Controller('admin/assets-import')
@Roles('sa', 'admin')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  /** Dry-run: bảng kết quả theo dòng, CHƯA ghi DB (AC 1). */
  @Post('preview')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: MULTER_LIMIT }))
  preview(@UploadedFile() file: Express.Multer.File | undefined) {
    return this.importService.preview(requireXlsx(file));
  }

  /** Import thật: atomic 1 transaction (AC 3). */
  @Post('commit')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: MULTER_LIMIT }))
  commit(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.importService.commit(requireXlsx(file), requireSub(req));
  }

  /** Đối chiếu lại USER (AC 6) — chạy được nhiều lần. */
  @Post('rematch')
  @HttpCode(200)
  rematch(@Req() req: AuthedRequest) {
    return this.importService.rematch(requireSub(req));
  }
}
