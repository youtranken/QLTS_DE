import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { IsObject, IsOptional, IsString, Matches } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import type { AuthedRequest } from '../auth/identity.guard';
import { MailSettingsService } from '../config/mail-settings.service';

function requireSub(req: AuthedRequest): string {
  if (!req.user) {
    throw new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: 'Chưa đăng nhập.',
    });
  }
  return req.user.sub;
}

class MailSettingsDto {
  /** Map topic→bật/tắt. Chỉ topic hợp lệ được áp (service lọc theo MAIL_TOPICS). */
  @IsOptional() @IsObject() enabled?: Record<string, boolean>;

  /** Giờ gửi digest 'HH:mm' (giờ VN). */
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'digestTime phải dạng HH:mm' })
  digestTime?: string;
}

/** Cấu hình thông báo (bật/tắt từng loại mail + giờ digest) — admin/sa. */
@Controller('admin/config/mail')
@Roles('sa', 'admin')
export class MailSettingsController {
  constructor(private readonly settings: MailSettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Put()
  update(@Body() body: MailSettingsDto, @Req() req: AuthedRequest) {
    return this.settings.update(body, requireSub(req));
  }
}
