import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { AuditQueryService } from './audit-query.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Ngày lịch THẬT (regex chỉ chặn định dạng) — mẫu reports.controller. */
function assertValidDate(s: string): void {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new BadRequestException(`Ngày không hợp lệ: ${s}`);
  }
}

class AuditQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  actor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  objectType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  objectId?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'from phải dạng YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'to phải dạng YYYY-MM-DD' })
  to?: string;

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
}

/** Viewer audit log (6.2, FR-43) — CHỈ SA; Admin 403 (RolesGuard). Chỉ đọc (AD-10). */
@Controller('admin/audit')
@Roles('sa')
export class AuditController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  list(@Query() q: AuditQueryDto) {
    if (q.from) assertValidDate(q.from);
    if (q.to) assertValidDate(q.to);
    if (q.from && q.to && q.to < q.from) {
      throw new BadRequestException('to phải ≥ from');
    }
    return this.audit.listAudit({
      actor: q.actor,
      action: q.action,
      objectType: q.objectType,
      objectId: q.objectId,
      from: q.from,
      to: q.to,
      page: q.page,
      pageSize: q.pageSize,
    });
  }

  @Get('actions')
  actions() {
    return this.audit.distinctActions();
  }
}
