import { Module } from '@nestjs/common';
import { SystemConfigModule } from '../config/config.module';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

/**
 * Engine interval + availability (AD-2/AD-3). Booking → Assets (read-only join
 * cho availability — AD-1). Story 3.1b: chỉ availability đọc; ghi booking từ 3.1c.
 */
@Module({
  imports: [SystemConfigModule],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
