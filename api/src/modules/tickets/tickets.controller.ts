import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { ExtensionService } from './extension.service';
import { RecurringLifecycleService } from './recurring-lifecycle.service';
import { RecurringService } from './recurring.service';
import { TicketsService } from './tickets.service';

/** Offset bắt buộc (party phiên 7) — như availability 3.1b. */
const HAS_OFFSET = /([+-]\d{2}:?\d{2}|Z)$/;

class SubmitBookingDto {
  @IsUUID()
  assetId!: string;

  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, { message: 'from phải là ISO-8601 có offset' })
  from!: string;

  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, { message: 'to phải là ISO-8601 có offset' })
  to!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(500)
  note?: string;
}

class RecurringSessionDto {
  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, { message: 'from phải là ISO-8601 có offset' })
  from!: string;

  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, { message: 'to phải là ISO-8601 có offset' })
  to!: string;
}

class RecurringDto {
  @IsUUID()
  assetId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => RecurringSessionDto)
  sessions!: RecurringSessionDto[];
}

class CancelTicketDto {
  /** Optimistic lock (FR-49) — version client đang cầm. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

class ExtendTicketDto {
  /** Hạn trả mới — ISO-8601 CÓ offset (chống lệch múi giờ, mẫu SubmitBookingDto). */
  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, { message: 'newDue phải là ISO-8601 có offset' })
  newDue!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

/**
 * Đặt mượn — vòng đời ticket là chủ của Tickets (AD-4). Member tự đặt cho mình;
 * Admin/SA KHÔNG đi luồng mượn (mục 3 PRD) — tạo hộ là 3.7 (endpoint riêng).
 */
@Controller('booking')
@Roles('member')
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly extension: ExtensionService,
    private readonly recurring: RecurringService,
    private readonly recurringLifecycle: RecurringLifecycleService,
  ) {}

  @Post()
  submit(@Body() body: SubmitBookingDto, @Req() req: AuthedRequest) {
    return this.tickets.submitOwnBooking(
      {
        assetId: body.assetId,
        from: body.from,
        to: body.to,
        note: body.note ?? null,
      },
      requireSub(req),
    );
  }

  /** Đặt chuỗi định kỳ (4.4) — 1 máy, N buổi, all-or-nothing. */
  @Post('recurring')
  @HttpCode(201)
  recurringSubmit(@Body() body: RecurringDto, @Req() req: AuthedRequest) {
    return this.recurring.submitRecurring(
      body.assetId,
      body.sessions,
      requireSub(req),
    );
  }

  /** "Request của tôi" (FR-11) — CHỈ ticket của chính member. */
  @Get('my-tickets')
  myTickets(@Req() req: AuthedRequest) {
    return this.tickets.listMyTickets(requireSub(req));
  }

  /** Chi tiết từng buổi của chuỗi định kỳ (4.5b) — chủ chuỗi từ session, chống IDOR. */
  @Get('my-tickets/:id/sessions')
  mySessions(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    return this.tickets.listMyRecurringSessions(id, requireSub(req));
  }

  /** Member hủy 1 buổi lẻ chưa giao, trước giờ nhận (4.6) — chủ buổi từ session, chống IDOR. */
  @Post('sessions/:id/cancel')
  @HttpCode(200)
  cancelSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelTicketDto,
    @Req() req: AuthedRequest,
  ) {
    return this.recurringLifecycle.cancelSession(
      id,
      body.version,
      requireSub(req),
      false,
    );
  }

  /** Bảng "Máy đang mượn" (7.4) — in_use toàn hệ + vé chờ nhận của caller; AD-5 không sub/email. */
  @Get('board')
  @Roles('member', 'admin', 'sa')
  board(@Req() req: AuthedRequest) {
    return this.tickets.listBoard(requireSub(req));
  }

  /** "Máy đang được mượn" (NFR-2, 3.11) — read-model snapshot, không lộ sub/email (AD-5). */
  @Get('in-use-now')
  @Roles('member', 'admin', 'sa')
  inUseNow() {
    return this.tickets.listInUseNow();
  }

  /** Member tự hủy request của mình (FR-11) — borrower từ session, không body (chống IDOR). */
  @Post('my-tickets/:id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelTicketDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tickets.cancelMyTicket(id, requireSub(req), body.version);
  }

  /** Member xin gia hạn (4.1, FR-18) — chủ ticket từ session, chống IDOR. */
  @Post('my-tickets/:id/extension')
  @HttpCode(201)
  extend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ExtendTicketDto,
    @Req() req: AuthedRequest,
  ) {
    return this.extension.requestExtension(
      id,
      body.newDue,
      requireSub(req),
      body.version,
    );
  }

  /**
   * Xem ảnh đính kèm ticket (NFR-8, AD-6): CHỦ ticket hoặc Admin/SA. Override @Roles
   * lớp (member-only) để admin/sa cũng vào; service kiểm chủ + ticket_file.
   */
  @Get('tickets/:id/photos/:fileId')
  @Roles('member', 'admin', 'sa')
  async photo(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ) {
    if (!req.user) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Chưa đăng nhập.',
      });
    }
    const { meta, stream } = await this.tickets.getTicketPhoto(
      id,
      fileId,
      req.user.sub,
      req.user.role,
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(meta.sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${fileId}"`);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.removeHeader('Content-Length');
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

function requireSub(req: AuthedRequest): string {
  if (!req.user) {
    throw new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: 'Chưa đăng nhập.',
    });
  }
  return req.user.sub;
}
