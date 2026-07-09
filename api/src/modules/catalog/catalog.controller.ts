import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import type { AuthedRequest } from '../auth/identity.guard';
import { CatalogService } from './catalog.service';
import { CATALOG_KINDS } from './catalog.schema';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1';

class ListCatalogDto {
  @IsIn(CATALOG_KINDS as readonly string[])
  kind!: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  activeOnly = false;
}

class CreateCatalogDto {
  @IsIn(CATALOG_KINDS as readonly string[])
  kind!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  value!: string;
}

class UpdateCatalogDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  value?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

class MergeDto {
  @IsUUID()
  from!: string;

  @IsUUID()
  to!: string;
}

class MergePreviewDto {
  @IsUUID()
  from!: string;

  @IsUUID()
  to!: string;
}

/** Danh mục Loại/Hãng/Cấu hình (8.1) — Admin/SA (form Thêm tài sản là admin-only). */
@Controller('admin/catalog')
@Roles('admin', 'sa')
export class CatalogAdminController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(@Query() query: ListCatalogDto) {
    return this.catalog.listByKind(query.kind, query.activeOnly);
  }

  @Get('merge-preview')
  mergePreview(@Query() query: MergePreviewDto) {
    return this.catalog.mergePreview(query.from, query.to);
  }

  @Post()
  create(@Body() body: CreateCatalogDto, @Req() req: AuthedRequest) {
    return this.catalog.create(body.kind, body.value, requireSub(req));
  }

  @Post('merge')
  merge(@Body() body: MergeDto, @Req() req: AuthedRequest) {
    return this.catalog.merge(body.from, body.to, requireSub(req));
  }

  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCatalogDto,
    @Req() req: AuthedRequest,
  ) {
    const sub = requireSub(req);
    // Sửa tên (rename, cascade tài sản) và ẩn/hiện (active) là hai thao tác khác nhau.
    if (body.value !== undefined)
      return this.catalog.rename(id, body.value, sub);
    if (body.active !== undefined)
      return this.catalog.setActive(id, body.active, sub);
    throw new BadRequestException({
      code: 'BAD_REQUEST',
      message: 'Phải có value (đổi tên) hoặc active (ẩn/hiện).',
    });
  }
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
