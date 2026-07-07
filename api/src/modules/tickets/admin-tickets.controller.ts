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
import { Transform, Type } from 'class-transformer';
import { IsInt, IsString, Length, Min } from 'class-validator';
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

/** Hàng đợi duyệt request (3.4) — CHỈ Admin/SA (NFR-7); member 403 từ RolesGuard. */
@Controller('admin/tickets')
@Roles('admin', 'sa')
export class AdminTicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get('pending-approval')
  pending() {
    return this.tickets.listPendingApproval();
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
