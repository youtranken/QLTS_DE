import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { TicketsService } from './tickets.service';

const trim = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value,
);

class ApproveDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

class RejectDto extends ApproveDto {
  /** BẮT BUỘC lý do từ chối (FR-13). */
  @trim
  @IsString()
  @Length(1, 500)
  reason!: string;
}

class DeliverDto extends ApproveDto {
  /** Note tình trạng lúc giao — TÙY CHỌN (FR-14). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  /** id ảnh đã upload qua /admin/files (kind=image) — tùy chọn. */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  photoIds?: string[];
}

class ReturnDto extends ApproveDto {
  /** Note tình trạng lúc nhận — BẮT BUỘC (FR-17). */
  @trim
  @IsString()
  @Length(1, 2000)
  note!: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  photoIds?: string[];
}

class HandoverQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize = 20;
}

const HAS_OFFSET = /([+-]\d{2}:?\d{2}|Z)$/;

class CreateForDto {
  @IsString()
  @Length(1, 255)
  borrowerSub!: string;

  @IsUUID()
  assetId!: string;

  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, { message: 'from phải là ISO-8601 có offset' })
  from!: string;

  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, { message: 'to phải là ISO-8601 có offset' })
  to!: string;

  @IsIn(['now', 'schedule'])
  mode!: 'now' | 'schedule';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  photoIds?: string[];
}

/** Hàng đợi duyệt request (3.4) — CHỈ Admin/SA (NFR-7); member 403 từ RolesGuard. */
@Controller('admin/tickets')
@Roles('admin', 'sa')
export class AdminTicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get('pending-approval')
  pending() {
    return this.tickets.listPendingApproval();
  }

  /** Hàng đợi chờ giao (FR-14). */
  @Get('awaiting-pickup')
  awaitingPickup() {
    return this.tickets.listQueue('awaiting_pickup');
  }

  /** Hàng đợi đang mượn — chờ nhận trả (FR-14). */
  @Get('in-use')
  inUse() {
    return this.tickets.listQueue('in_use');
  }

  /** Hàng đợi quá hạn (FR-15) — sort thời lượng giảm dần. */
  @Get('overdue')
  overdue() {
    return this.tickets.listOverdue();
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApproveDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tickets.approveRequest(id, body.version, requireSub(req));
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RejectDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tickets.rejectRequest(
      id,
      body.version,
      body.reason,
      requireSub(req),
    );
  }

  /** Xác nhận đã giao (FR-14). Ảnh upload trước qua /admin/files → photoIds. */
  @Post(':id/deliver')
  @HttpCode(200)
  deliver(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliverDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tickets.deliver(
      id,
      body.version,
      body.note ?? null,
      body.photoIds ?? [],
      requireSub(req),
    );
  }

  /** Xác nhận đã nhận (FR-14/17) — note tình trạng bắt buộc. */
  @Post(':id/return')
  @HttpCode(200)
  return(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReturnDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tickets.returnTicket(
      id,
      body.version,
      body.note,
      body.photoIds ?? [],
      requireSub(req),
    );
  }

  /** Admin tạo request hộ member (FR-12) — 2 chế độ giao-ngay/đặt-lịch. */
  @Post('create-for')
  @HttpCode(201)
  createFor(@Body() body: CreateForDto, @Req() req: AuthedRequest) {
    return this.tickets.createForMember(
      {
        borrowerSub: body.borrowerSub,
        assetId: body.assetId,
        from: body.from,
        to: body.to,
        mode: body.mode,
        note: body.note ?? null,
        photoIds: body.photoIds ?? [],
      },
      requireSub(req),
    );
  }

  /** Tab "Mượn-trả" của máy (FR-34) — Tickets đọc (AD-1: không cạnh ngược Assets→Tickets). */
  @Get('by-asset/:assetId/handovers')
  handovers(
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Query() query: HandoverQueryDto,
  ) {
    return this.tickets.listAssetHandovers(assetId, query.page, query.pageSize);
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
