import {
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
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { AssetsService } from './assets.service';
import type { AssetInput } from './assets.service';

/**
 * DTO form tài sản (FR-30). status/isPool KHÔNG nhận từ client:
 * tạo mới luôn in_use + pool TẮT; đổi trạng thái/pool là nghiệp vụ riêng 2.6.
 */
/** Trim TRƯỚC validate (review 2.1) — '   ' không được lọt Length(1) rồi thành ''. */
const trim = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value,
);

class AssetBodyDto {
  @trim
  @IsString()
  @Length(1, 100)
  code!: string;

  @trim
  @IsString()
  @Length(1, 100)
  type!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  configuration?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  // review 2.1: > 2^53 mất chính xác từ tầng JSON, > bigint max → 500; chặn 400 sạch
  @Max(Number.MAX_SAFE_INTEGER)
  cost?: number | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'startDate phải dạng YYYY-MM-DD' })
  startDate?: string | null;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'endDate phải dạng YYYY-MM-DD' })
  endDate?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  floor?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  serial?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  brand?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  assignedUserSub?: string | null;
}

class UpdateAssetDto extends AssetBodyDto {
  /** Optimistic lock (FR-49) — version client đang cầm. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

class ListAssetsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  /** Tìm mã tài sản HOẶC tên người đứng tên (story 2.2). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  type?: string;

  @IsOptional()
  @IsIn(['in_use', 'locked_repair', 'disposed'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  floor?: string;
}

function toInput(body: AssetBodyDto): AssetInput {
  return {
    code: body.code.trim(),
    type: body.type.trim(),
    configuration: body.configuration ?? null,
    cost: body.cost ?? null,
    startDate: body.startDate ?? null,
    endDate: body.endDate ?? null,
    // '' → null: floor rỗng không được thành option "ma" trong meta dropdown (review 2.2)
    floor: body.floor?.trim() || null,
    note: body.note ?? null,
    serial: body.serial ?? null,
    brand: body.brand ?? null,
    model: body.model ?? null,
    assignedUserSub: body.assignedUserSub ?? null,
  };
}

/** Sổ tài sản (2.1) — CHỈ Admin/SA (NFR-7); member 403 từ RolesGuard. */
@Controller('admin/assets')
@Roles('sa', 'admin')
export class AssetsAdminController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  list(@Query() query: ListAssetsQueryDto) {
    return this.assets.list({
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      type: query.type,
      status: query.status,
      floor: query.floor,
    });
  }

  /** Dropdown lọc (2.2) — PHẢI đứng trước ':id' để 'meta' không rơi vào ParseUUIDPipe. */
  @Get('meta')
  filterMeta() {
    return this.assets.filterMeta();
  }

  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.getById(id);
  }

  @Post()
  create(@Body() body: AssetBodyDto, @Req() req: AuthedRequest) {
    return this.assets.create(toInput(body), requireSub(req));
  }

  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAssetDto,
    @Req() req: AuthedRequest,
  ) {
    return this.assets.update(id, toInput(body), body.version, requireSub(req));
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
