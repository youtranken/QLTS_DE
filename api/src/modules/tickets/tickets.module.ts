import { Module } from '@nestjs/common';
import { SystemConfigModule } from '../config/config.module';
import { AdminTicketsController } from './admin-tickets.controller';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { TicketsSweepRegistrar } from './tickets-sweep.registrar';

/**
 * Chủ vòng đời ticket/booking (AD-4). Story 3.1a đặt nền DB + từ vựng
 * (ticket-states.ts); 3.1c thêm submit đặt mượn ≤48h tự-duyệt + giữ chỗ >48h.
 * Quyền dài hạn đọc trực tiếp trong tx (can_long_term hàng users đã FOR UPDATE) —
 * không cần UsersService, tránh TOCTOU.
 */
@Module({
  imports: [SystemConfigModule],
  controllers: [TicketsController, AdminTicketsController],
  providers: [TicketsService, TicketsSweepRegistrar],
  exports: [TicketsService],
})
export class TicketsModule {}
