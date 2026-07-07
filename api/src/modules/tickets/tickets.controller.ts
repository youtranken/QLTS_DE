import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsUUID, Matches, Min } from 'class-validator';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
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
}

class CancelTicketDto {
  /** Optimistic lock (FR-49) — version client đang cầm. */
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
  constructor(private readonly tickets: TicketsService) {}

  @Post()
  submit(@Body() body: SubmitBookingDto, @Req() req: AuthedRequest) {
    return this.tickets.submitOwnBooking(
      { assetId: body.assetId, from: body.from, to: body.to },
      requireSub(req),
    );
  }

  /** "Request của tôi" (FR-11) — CHỈ ticket của chính member. */
  @Get('my-tickets')
  myTickets(@Req() req: AuthedRequest) {
    return this.tickets.listMyTickets(requireSub(req));
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
