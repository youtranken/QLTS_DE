import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { BookingService } from './booking.service';

/** Offset BẮT BUỘC (party phiên 7): IsISO8601 strict vẫn nhận datetime KHÔNG offset —
 * '9h sáng' của client TZ sẽ lệch giờ. Ép có `Z` hoặc offset (extended `±HH:MM` hoặc
 * basic `±HHMM`) cuối chuỗi. IsISO8601 strict AND-ed nên giờ/phút vô lý vẫn bị chặn. */
const HAS_OFFSET = /([+-]\d{2}:?\d{2}|Z)$/;

class AvailabilityQueryDto {
  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, {
    message: 'from phải là ISO-8601 có offset (Z hoặc ±HH:MM)',
  })
  from!: string;

  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, {
    message: 'to phải là ISO-8601 có offset (Z hoặc ±HH:MM)',
  })
  to!: string;

  /** Lọc loại tài sản (7.3) — chuỗi tự do trong assets, không enum cứng. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  type?: string;
}

class CalendarQueryDto {
  /** Tuần cần xem — mặc định tuần hiện tại nếu bỏ trống. */
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(HAS_OFFSET, { message: 'weekStart phải là ISO-8601 có offset' })
  weekStart?: string;
}

/**
 * Đặt mượn (Epic 3). Availability là read-model công khai nội bộ — chỉ máy + khung,
 * KHÔNG lộ người mượn (AD-5). Admin/SA cũng gọi được (3.7 tạo hộ reuse).
 */
@Controller('booking')
@Roles('member', 'admin', 'sa')
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  @Get('availability')
  availability(@Query() query: AvailabilityQueryDto) {
    return this.booking.availableMachines(
      query.from,
      query.to,
      query.type ?? null,
    );
  }

  /** Distinct loại máy pool đang dùng (7.3) — dropdown lọc loại ở popup đặt máy. */
  @Get('asset-types')
  assetTypes() {
    return this.booking.assetTypes();
  }

  /** Máy pool đang rảnh ngay bây giờ (9.5) — bảng "Máy có thể mượn" ở trang chủ. */
  @Get('pool-machines')
  poolMachines() {
    return this.booking.poolFreeNow();
  }

  /** TẤT CẢ máy pool + trạng thái rảnh/bận (Phase 1b) — catalog Mượn máy hiện cả máy bận. */
  @Get('pool-all-machines')
  poolAllMachines() {
    return this.booking.poolAllWithStatus();
  }

  /** Lịch tuần busy/free của một máy (FR-10) — AD-5: không lộ người mượn. */
  @Get('machines/:id/calendar')
  calendar(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CalendarQueryDto,
  ) {
    return this.booking.machineCalendar(id, query.weekStart ?? null);
  }

  /** Lịch tuần TỔNG mọi máy pool (mục sidebar "Lịch máy") — AD-5: không lộ người mượn. */
  @Get('calendar')
  poolCalendar(@Query() query: CalendarQueryDto) {
    return this.booking.poolCalendar(query.weekStart ?? null);
  }
}
