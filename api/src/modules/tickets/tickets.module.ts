import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { SystemConfigModule } from '../config/config.module';
import { FilesModule } from '../files/files.module';
import { AdminTicketsController } from './admin-tickets.controller';
import { AssetLifecycleController } from './asset-lifecycle.controller';
import { OffboardingController } from './offboarding.controller';
import { TicketsController } from './tickets.controller';
import { ApprovalReminderService } from './approval-reminder.service';
import { OverdueReminderService } from './overdue-reminder.service';
import { OffboardingService } from './offboarding.service';
import { ExtensionService } from './extension.service';
import { RecurringLifecycleService } from './recurring-lifecycle.service';
import { RecurringService } from './recurring.service';
import { TicketsService } from './tickets.service';
import { TicketsSweepRegistrar } from './tickets-sweep.registrar';

/**
 * Chủ vòng đời ticket/booking (AD-4). Story 3.1a đặt nền DB + từ vựng
 * (ticket-states.ts); 3.1c thêm submit đặt mượn ≤48h tự-duyệt + giữ chỗ >48h.
 * Quyền dài hạn đọc trực tiếp trong tx (can_long_term hàng users đã FOR UPDATE) —
 * không cần UsersService, tránh TOCTOU.
 */
@Module({
  imports: [SystemConfigModule, FilesModule, AssetsModule],
  controllers: [
    TicketsController,
    AdminTicketsController,
    AssetLifecycleController,
    OffboardingController,
  ],
  providers: [
    TicketsService,
    ExtensionService,
    RecurringService,
    RecurringLifecycleService,
    ApprovalReminderService,
    OverdueReminderService,
    OffboardingService,
    TicketsSweepRegistrar,
  ],
  exports: [
    TicketsService,
    ExtensionService,
    RecurringService,
    RecurringLifecycleService,
  ],
})
export class TicketsModule {}
