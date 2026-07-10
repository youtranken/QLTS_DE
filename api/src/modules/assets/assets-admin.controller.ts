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
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
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
  @MaxLength(255)
  assignedUserSub?: string | null;

  /** Software (2.4) — chỉ hợp lệ khi type='software' (service validate). */
  @IsOptional()
  @IsIn(['term', 'perpetual'])
  licenseType?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  licenseName?: string | null;
}

class CreateAssetDto extends AssetBodyDto {
  /** Gắn máy CHỈ khi tạo (2.4, AC 3) — đổi/gỡ là "chuyển" ở 2.5. */
  @IsOptional()
  @IsUUID()
  installedOnAssetId?: string | null;
}

class UpdateAssetDto extends AssetBodyDto {
  /** Optimistic lock (FR-49) — version client đang cầm. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;

  /** Ghi chú cấp phát (2.3) — chỉ được dùng khi đổi người đứng tên. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  allocationNote?: string | null;
}

// LockAssetDto/VersionDto/SetPoolDto CHUYỂN sang AssetLifecycleController (3.10).

class TransferLicenseDto {
  /** Bỏ trống = gỡ về "chưa gắn máy" (2.5). */
  @IsOptional()
  @IsUUID()
  targetAssetId?: string | null;

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

  /** 7.7: lọc "sắp hết hạn" (?expiring=true). */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  expiring?: boolean;

  /** Sắp xếp server-side (P1): whitelist cột — chặn SQL injection qua tên cột. */
  @IsOptional()
  @IsIn(['code', 'type', 'status', 'assignee'])
  sort?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  dir?: string;
}

function toInput(body: AssetBodyDto): AssetInput {
  return {
    code: body.code.trim(),
    type: body.type.trim(),
    configuration: body.configuration ?? null,
    cost: body.cost ?? null,
    startDate: body.startDate ?? null,
    endDate: body.endDate ?? null,
    note: body.note ?? null,
    serial: body.serial ?? null,
    brand: body.brand ?? null,
    // trim + '' → null: '  ' = thu hồi chứ không phải 400 khó hiểu
    assignedUserSub: body.assignedUserSub?.trim() || null,
    licenseType: body.licenseType ?? null,
    licenseName: body.licenseName?.trim() || null,
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
      expiring: query.expiring,
      sort: query.sort,
      dir: query.dir,
    });
  }

  /** Dropdown lọc (2.2) — PHẢI đứng trước ':id' để 'meta' không rơi vào ParseUUIDPipe. */
  @Get('meta')
  filterMeta() {
    return this.assets.filterMeta();
  }

  /** Badge "Sắp hết hạn" (7.7) — đứng trước ':id' như 'meta'. */
  @Get('expiring-count')
  async expiringCount() {
    return { count: await this.assets.countExpiring() };
  }

  /** Export Excel theo bộ lọc (2.10, FR-41) — đứng trước ':id' như 'meta'. */
  @Get('export')
  // dựng workbook 10k dòng RAM — siết 20 req/phút/user (epic review)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async exportExcel(
    @Query() query: ListAssetsQueryDto,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    const { buffer } = await this.assets.exportExcel(
      {
        search: query.search,
        type: query.type,
        status: query.status,
        expiring: query.expiring,
      },
      requireSub(req),
    );
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="tai-san-${today}.xlsx"`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buffer);
  }

  @Get(':id')
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.getById(id);
  }

  /** Lịch sử cấp phát (2.3) — chỉ đọc, giảm dần theo thời gian. */
  @Get(':id/allocations')
  listAllocations(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.listAllocations(id);
  }

  /** Note tình trạng (2.7, FR-34) — tab thứ 3 trang chi tiết. */
  @Get(':id/notes')
  listNotes(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.listNotes(id);
  }

  /** Software đã cài trên máy (2.4, AC 2) — 2.7/Epic 3 dùng lại. */
  @Get(':id/software')
  listInstalledSoftware(@Param('id', ParseUUIDPipe) id: string) {
    return this.assets.listInstalledSoftware(id);
  }

  // Vòng đời máy (lock/unlock/dispose/pool) CHUYỂN sang AssetLifecycleController trong
  // TicketsModule (3.10) — orchestrator Tickets→Assets cascade hủy booking cùng tx (AD-1).
  // Path `/admin/assets/:id/...` giữ nguyên; FE không đổi.

  /** Chuyển license giữa máy / gỡ về "chưa gắn máy" (2.5, FR-50). */
  @Put(':id/transfer')
  transferLicense(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TransferLicenseDto,
    @Req() req: AuthedRequest,
  ) {
    return this.assets.transferLicense(
      id,
      body.targetAssetId ?? null,
      body.version,
      requireSub(req),
    );
  }

  @Post()
  create(@Body() body: CreateAssetDto, @Req() req: AuthedRequest) {
    return this.assets.create(
      toInput(body),
      requireSub(req),
      body.installedOnAssetId ?? null,
    );
  }

  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAssetDto,
    @Req() req: AuthedRequest,
  ) {
    return this.assets.update(
      id,
      toInput(body),
      body.version,
      requireSub(req),
      body.allocationNote?.trim() || null,
    );
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
