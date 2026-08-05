import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../auth/roles.decorator';
import type { AuthedRequest } from '../auth/identity.guard';
import { SmtpConfigService } from '../config/smtp-config.service';
import { MailTransportService } from './mail-transport.service';

const trim = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value,
);

class SmtpUpdateDto {
  @IsOptional() @trim @IsString() @MaxLength(255) host?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsBoolean() secure?: boolean;
  @IsOptional() @trim @IsString() @MaxLength(255) user?: string;
  @IsOptional() @trim @IsString() @MaxLength(255) from?: string;
  /** Chỉ gửi khi ĐỔI mật khẩu; bỏ trống = giữ nguyên. Gmail: dùng App Password 16 ký tự. */
  @IsOptional() @IsString() @MaxLength(512) pass?: string;
}

class SmtpTestDto {
  @IsEmail()
  @MaxLength(255)
  to!: string;
}

/**
 * Cấu hình SMTP qua UI (admin/sa). GET không trả password. PUT lưu (password mã hoá ở service).
 * POST test gửi 1 mail thử bằng cấu hình ĐÃ LƯU → phản hồi ok/lỗi ngay cho admin.
 */
@Controller('admin/config/smtp')
@Roles('sa', 'admin')
export class SmtpConfigController {
  constructor(
    private readonly smtp: SmtpConfigService,
    private readonly mail: MailTransportService,
  ) {}

  @Get()
  get() {
    return this.smtp.get();
  }

  @Put()
  async update(@Body() body: SmtpUpdateDto, @Req() req: AuthedRequest) {
    if (!req.user) throw new UnauthorizedException({ code: 'UNAUTHENTICATED' });
    await this.smtp.update(body, req.user.sub);
    return this.smtp.get();
  }

  // Gửi mail thật → siết 5 lần/phút/user (chống lạm dụng gửi spam / cháy quota Gmail).
  @Post('test')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async test(@Body() body: SmtpTestDto): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.mail.send({
        to: body.to,
        subject: 'QLTS: Email thử cấu hình SMTP',
        text: 'Đây là email thử từ QLTS. Nếu bạn nhận được, cấu hình SMTP đã hoạt động.',
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
