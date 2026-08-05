import { Injectable, OnModuleInit } from '@nestjs/common';
import { SweepService } from '../queue/sweep.service';
import { ApprovalReminderService } from './approval-reminder.service';
import { OverdueReminderService } from './overdue-reminder.service';
import { DueReminderService } from './due-reminder.service';
import { OffboardingService } from './offboarding.service';
import { ExtensionService } from './extension.service';
import { RecurringLifecycleService } from './recurring-lifecycle.service';
import { RecurringService } from './recurring.service';
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
    private readonly extension: ExtensionService,
    private readonly recurring: RecurringService,
    private readonly recurringLifecycle: RecurringLifecycleService,
    private readonly approvalReminder: ApprovalReminderService,
    private readonly overdueReminder: OverdueReminderService,
    private readonly dueReminder: DueReminderService,
    private readonly offboarding: OffboardingService,
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
    // 4.3: vô hiệu yêu cầu gia hạn khi hạn trả cũ đã trôi qua (không duyệt hồi tố)
    this.sweep.register({
      name: 'expire-extension',
      run: async () => {
        await this.extension.expireStaleExtensions();
      },
    });
    // 4.4: chuỗi định kỳ chờ duyệt hết hạn khi buổi đầu trôi qua (all-or-nothing)
    this.sweep.register({
      name: 'expire-recurring',
      run: async () => {
        await this.recurring.expireStalePendingRecurring();
      },
    });
    // 4.5a: no-show per-buổi định kỳ (buổi pending hết giờ → chỉ buổi đó cancelled)
    this.sweep.register({
      name: 'no-show-recurring-session',
      run: async () => {
        await this.recurringLifecycle.autoCloseNoShowRecurringSessions();
      },
    });
    // 5.2: nhắc duyệt request treo quá 4 giờ làm việc (1 mail/ngày VN)
    this.sweep.register({
      name: 'approval-reminder',
      run: async () => {
        await this.approvalReminder.emitApprovalReminders();
      },
    });
    // 5.3: nhắc quá hạn hằng ngày (1 mail/ngày VN đến khi ticket close)
    this.sweep.register({
      name: 'overdue-reminder',
      run: async () => {
        await this.overdueReminder.emitOverdueReminders();
      },
    });
    // Nhắc "tới hạn trả": 1 mail đúng lúc buổi mượn hết hạn (Admin + người mượn)
    this.sweep.register({
      name: 'due-reminder',
      run: async () => {
        await this.dueReminder.emitDueReminders();
      },
    });
    // 5.5: cảnh báo nghỉ việc — user disable còn ticket/tài sản (cascade + mail Admin)
    this.sweep.register({
      name: 'offboard-scan',
      run: async () => {
        await this.offboarding.runOffboardingScan();
      },
    });
  }
}
