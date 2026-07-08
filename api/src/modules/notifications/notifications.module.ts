import { Module } from '@nestjs/common';
import { SystemConfigModule } from '../config/config.module';
import { ApprovalMailRegistrar } from './approval-mail.registrar';
import { OverdueMailRegistrar } from './overdue-mail.registrar';
import { CascadeCancelMailRegistrar } from './cascade-cancel-mail.registrar';
import { MailTransportService } from './mail-transport.service';
import { NotificationRecipientsService } from './notification-recipients.service';
import { NotificationsConsumer } from './notifications.consumer';
import { NotificationsController } from './notifications.controller';

/**
 * Notifications (AD-11) — consumer mail chạy ở worker + endpoint badge lỗi cho API. OutboxService
 * và AuditWriterService là @Global; chỉ cần import SystemConfigModule (baseline durable).
 * 5.2–5.6 mở rộng consumer bằng register(topic, handler).
 */
@Module({
  imports: [SystemConfigModule],
  providers: [
    NotificationsConsumer,
    MailTransportService,
    NotificationRecipientsService,
    ApprovalMailRegistrar,
    OverdueMailRegistrar,
    CascadeCancelMailRegistrar,
  ],
  controllers: [NotificationsController],
  exports: [NotificationsConsumer],
})
export class NotificationsModule {}
