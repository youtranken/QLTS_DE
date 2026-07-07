import { BadRequestException, ConflictException } from '@nestjs/common';

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}

/**
 * Exception mapper 409 cho lỗi DB tầng booking (AD-2/AD-15, Consistency Conventions):
 *  - 23P01 (EXCLUDE chồng giờ) → 409 SLOT_TAKEN
 *  - P0001 message 'ASSET_UNAVAILABLE' (trigger bookability AD-15) → 409 ASSET_UNAVAILABLE
 *  - 23514 (CHECK period bound/rỗng) → 400 INVALID_RANGE
 * FE ăn 409 PHẢI refetch availability trước khi submit lại (conventions).
 * Lỗi khác → trả nguyên (caller/global filter xử). Drizzle bọc lỗi trong Error.cause.
 */
export function mapBookingPgError(error: unknown): unknown {
  const pg = (
    error instanceof Error && 'cause' in error && error.cause
      ? error.cause
      : error
  ) as PgError;
  if (pg?.code === '23P01') {
    return new ConflictException({
      code: 'SLOT_TAKEN',
      message: 'Khung giờ này vừa có người đặt — vui lòng chọn lại.',
    });
  }
  if (pg?.code === 'P0001' && pg.message?.includes('ASSET_UNAVAILABLE')) {
    return new ConflictException({
      code: 'ASSET_UNAVAILABLE',
      message: 'Máy vừa bị khóa/ngừng cho mượn — vui lòng chọn máy khác.',
    });
  }
  if (pg?.code === '23514') {
    return new BadRequestException({
      code: 'INVALID_RANGE',
      message: 'Khung giờ không hợp lệ.',
    });
  }
  if (pg?.code === '40P01') {
    // Deadlock (cascade khóa-máy ⟷ submit đặt cùng lúc: thứ tự khóa asset↔ticket
    // ngược nhau — review Epic 3 F11). PG đã abort 1 nhánh, dữ liệu nhất quán; trả 409
    // để FE thử lại (refetch availability) thay vì 500 thô.
    return new ConflictException({
      code: 'RETRY',
      message: 'Hệ thống bận xử lý — vui lòng thử lại.',
    });
  }
  return error;
}
