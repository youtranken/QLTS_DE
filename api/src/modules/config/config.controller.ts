import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { ConfigAdminService } from './config-admin.service';

class WorkingHoursDto {
  @IsString()
  tz!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  days!: number[];

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'start phải dạng HH:MM' })
  start!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'end phải dạng HH:MM' })
  end!: string;
}

/** Biên hợp lý FR-44 (AC2) — số nguyên trong khoảng; end>start kiểm ở service. */
class ConfigUpdateDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  booking_window_days?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  active_ticket_quota?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  extension_days_per_grant?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  extension_max_grants?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  license_warning_days?: number;

  // Tuổi thọ máy (năm) cho cảnh báo EOL — 1..50 năm.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  asset_lifespan_years?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(24)
  approval_reminder_working_hours?: number;

  // audit H2: ngưỡng auto-duyệt (giờ). 1..720h (~30 ngày) — SA chỉnh chính sách.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  auto_approve_max_hours?: number;

  // audit H-2: trần thời lượng MỘT lượt mượn (giờ). 1..8760h (~1 năm) là biên kỹ thuật;
  // giá trị nghiệp vụ chốt là 2160h (90 ngày), seed ở 0041.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8760)
  max_booking_duration_hours?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => WorkingHoursDto)
  working_hours?: WorkingHoursDto;
}

/** Cấu hình tham số hệ thống (6.3, FR-44) — SA + Admin (delegation 10.1). */
@Controller('admin/config')
@Roles('sa', 'admin')
export class ConfigController {
  constructor(private readonly configAdmin: ConfigAdminService) {}

  @Get()
  list() {
    return this.configAdmin.listEditable();
  }

  @Put()
  update(@Body() body: ConfigUpdateDto, @Req() req: AuthedRequest) {
    if (!req.user) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Chưa đăng nhập.',
      });
    }
    return this.configAdmin.update(body, req.user.sub);
  }
}
