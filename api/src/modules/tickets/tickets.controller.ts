import {
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { IsISO8601, IsUUID, Matches } from 'class-validator';
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
    if (!req.user) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Chưa đăng nhập.',
      });
    }
    return this.tickets.submitOwnBooking(
      { assetId: body.assetId, from: body.from, to: body.to },
      req.user.sub,
    );
  }
}
