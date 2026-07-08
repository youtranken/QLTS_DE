import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { ReportsService } from './reports.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Kỳ báo cáo: ngày VN dạng YYYY-MM-DD, bắt buộc; `to >= from` kiểm ở handler. */
class PeriodDto {
  @Matches(DATE_RE, { message: 'from phải dạng YYYY-MM-DD' })
  from!: string;

  @Matches(DATE_RE, { message: 'to phải dạng YYYY-MM-DD' })
  to!: string;
}

class PagedPeriodDto extends PeriodDto {
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

function assertOrder(from: string, to: string): void {
  if (to < from) throw new BadRequestException('to phải ≥ from');
}

/** Báo cáo mượn & quá hạn (FR-42) — chỉ Admin/SA; member 403 từ RolesGuard. */
@Controller('reports')
@Roles('admin', 'sa')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('borrow-by-asset')
  borrowByAsset(@Query() q: PagedPeriodDto) {
    assertOrder(q.from, q.to);
    return this.reports.borrowByAsset(q.from, q.to, q.page, q.pageSize);
  }

  @Get('borrow-by-user')
  borrowByUser(@Query() q: PagedPeriodDto) {
    assertOrder(q.from, q.to);
    return this.reports.borrowByUser(q.from, q.to, q.page, q.pageSize);
  }

  @Get('overdue-ratio')
  overdueRatio(@Query() q: PeriodDto) {
    assertOrder(q.from, q.to);
    return this.reports.overdueRatio(q.from, q.to);
  }
}
