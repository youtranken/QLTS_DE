import { Injectable, OnModuleInit } from '@nestjs/common';
import { SweepService } from '../queue/sweep.service';
import { TicketsService } from './tickets.service';

/**
 * Đăng ký các sweep handler của Tickets vào SweepService (AD-9). Chạy ở CẢ api và worker
 * process, nhưng sweep.runAll() chỉ được gọi ở worker (SWEEP worker) — api không quét.
 * 3.5b: auto-expire request pending_approval quá giờ nhận. 3.8/3.9 thêm handler sau.
 */
@Injectable()
export class TicketsSweepRegistrar implements OnModuleInit {
  constructor(
    private readonly sweep: SweepService,
    private readonly tickets: TicketsService,
  ) {}

  onModuleInit(): void {
    this.sweep.register({
      name: 'expire-pending-approval',
      run: async () => {
        await this.tickets.expireStalePendingApprovals();
      },
    });
    this.sweep.register({
      name: 'mark-overdue',
      run: async () => {
        await this.tickets.markOverdue();
      },
    });
    // No-show TRƯỚC reminder: ticket hết hạn thì close, không nhắc nữa (3.9)
    this.sweep.register({
      name: 'auto-close-no-show',
      run: async () => {
        await this.tickets.autoCloseNoShow();
      },
    });
    this.sweep.register({
      name: 'pickup-reminder',
      run: async () => {
        await this.tickets.emitPickupReminders();
      },
    });
  }
}
