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
  ArrayMaxSize,
  ArrayMinSize,
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
  ValidateNested,
} from 'class-validator';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { ExtensionService } from './extension.service';
import { RecurringLifecycleService } from './recurring-lifecycle.service';
import { RecurringService } from './recurring.service';
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

/** Admin gia hạn thẳng (đường B): chỉ cần hạn trả mới (ISO). Không cần version (admin override). */
class AdminExtendDto {
  @IsISO8601()
  newDue!: string;
}

/** Hủy cưỡng chế (audit H-2): BẮT BUỘC lý do — đây là quyền đè lên request người khác. */
class ForceCancelDto {
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

class RecurringForSessionDto {
  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, { message: 'from phải là ISO-8601 có offset' })
  from!: string;

  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, { message: 'to phải là ISO-8601 có offset' })
  to!: string;
}

/** Admin đặt chuỗi định kỳ HỘ member (7.5) — bỏ quota/quyền, vẫn all-or-nothing. */
class RecurringForDto {
  @IsString()
  @Length(1, 255)
  borrowerSub!: string;

  @IsUUID()
  assetId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => RecurringForSessionDto)
  sessions!: RecurringForSessionDto[];
}

/** Hàng đợi duyệt request (3.4) — CHỈ Admin/SA (NFR-7); member 403 từ RolesGuard. */
@Controller('admin/tickets')
@Roles('admin', 'sa')
export class AdminTicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly extension: ExtensionService,
    private readonly recurringLifecycle: RecurringLifecycleService,
    private readonly recurring: RecurringService,
  ) {}

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

  /** Hàng đợi Chờ gia hạn (4.2). */
  @Get('extensions')
  extensions() {
    return this.extension.listPendingExtensions();
  }

  /** Duyệt gia hạn (4.2) — :id là dòng extension booking. */
  @Post('extensions/:id/approve')
  @HttpCode(200)
  approveExtension(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApproveDto,
    @Req() req: AuthedRequest,
  ) {
    return this.extension.approveExtension(id, body.version, requireSub(req));
  }

  /** Từ chối gia hạn (4.2) — bắt buộc lý do. */
  @Post('extensions/:id/reject')
  @HttpCode(200)
  rejectExtension(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RejectDto,
    @Req() req: AuthedRequest,
  ) {
    return this.extension.rejectExtension(
      id,
      body.version,
      body.reason,
      requireSub(req),
    );
  }

  /** Admin gia hạn THẲNG (đường B) — :id là ticket đang mượn; đặt hạn trả mới ngay. */
  @Post(':id/extend')
  @HttpCode(200)
  adminExtend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdminExtendDto,
    @Req() req: AuthedRequest,
  ) {
    return this.extension.adminExtend(id, body.newDue, requireSub(req));
  }

  /**
   * Hủy CƯỠNG CHẾ ticket của người khác (audit H-2) — lối thoát khi máy bị giam bởi
   * booking đã duyệt: member hết quyền hủy sau giờ nhận, sweep không đụng 'pending'.
   * Không cần version: admin quyết trên hiện trạng, không phải đồng thuận lạc quan.
   */
  @Post(':id/force-cancel')
  @HttpCode(200)
  forceCancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ForceCancelDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tickets.adminForceCancel(id, requireSub(req), body.reason);
  }

  /** Hàng đợi giao/nhận từng buổi của chuỗi định kỳ (4.5a). */
  @Get('recurring-sessions')
  recurringSessions() {
    return this.recurring.listSessionQueue();
  }

  /** Duyệt cả chuỗi định kỳ (4.5a) — :id là ticket cha kind='recurring'. */
  @Post('recurring/:id/approve')
  @HttpCode(200)
  approveChain(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApproveDto,
    @Req() req: AuthedRequest,
  ) {
    return this.recurringLifecycle.approveChain(
      id,
      body.version,
      requireSub(req),
    );
  }

  /** Từ chối cả chuỗi định kỳ (4.5a) — bắt buộc lý do. */
  @Post('recurring/:id/reject')
  @HttpCode(200)
  rejectChain(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RejectDto,
    @Req() req: AuthedRequest,
  ) {
    return this.recurringLifecycle.rejectChain(
      id,
      body.version,
      body.reason,
      requireSub(req),
    );
  }

  /** Giao 1 buổi của chuỗi (4.5a) — :id là booking buổi (pending→delivered). */
  @Post('sessions/:id/deliver')
  @HttpCode(200)
  deliverSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliverDto,
    @Req() req: AuthedRequest,
  ) {
    return this.recurringLifecycle.deliverSession(
      id,
      body.version,
      body.note ?? null,
      body.photoIds ?? [],
      requireSub(req),
    );
  }

  /** Nhận trả 1 buổi của chuỗi (4.5a) — :id là booking buổi (delivered→returned). */
  @Post('sessions/:id/return')
  @HttpCode(200)
  returnSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReturnDto,
    @Req() req: AuthedRequest,
  ) {
    return this.recurringLifecycle.returnSession(
      id,
      body.version,
      body.note,
      body.photoIds ?? [],
      requireSub(req),
    );
  }

  /** Admin hủy 1 buổi CHƯA giao (4.6 AC3) — được cả sau giờ nhận (isAdmin=true). */
  @Post('sessions/:id/cancel')
  @HttpCode(200)
  cancelSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApproveDto,
    @Req() req: AuthedRequest,
  ) {
    return this.recurringLifecycle.cancelSession(
      id,
      body.version,
      requireSub(req),
      true,
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

  /** Admin đặt chuỗi định kỳ hộ member (7.5) — bỏ quota/quyền, coi như đã duyệt. */
  @Post('recurring-for')
  @HttpCode(201)
  recurringFor(@Body() body: RecurringForDto, @Req() req: AuthedRequest) {
    return this.recurring.createRecurringForMember(
      body.assetId,
      body.sessions,
      body.borrowerSub,
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
