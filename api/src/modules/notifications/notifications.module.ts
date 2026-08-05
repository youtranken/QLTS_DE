import { Module } from '@nestjs/common';
import { SystemConfigModule } from '../config/config.module';
import { ApprovalMailRegistrar } from './approval-mail.registrar';
import { OverdueMailRegistrar } from './overdue-mail.registrar';
import { DueReminderMailRegistrar } from './due-reminder-mail.registrar';
import { CascadeCancelMailRegistrar } from './cascade-cancel-mail.registrar';
import { ForceCancelMailRegistrar } from './force-cancel-mail.registrar';
import { OffboardMailRegistrar } from './offboard-mail.registrar';
import { LicenseDigestMailRegistrar } from './license-digest-mail.registrar';
import { EolDigestMailRegistrar } from './eol-digest-mail.registrar';
import { MailTransportService } from './mail-transport.service';
import { NotificationRecipientsService } from './notification-recipients.service';
import { NotificationsConsumer } from './notifications.consumer';
import { NotificationsController } from './notifications.controller';
import { SmtpConfigController } from './smtp-config.controller';
import { MailSettingsController } from './mail-settings.controller';
import { ExtensionMailRegistrar } from './extension-mail.registrar';
import { RequestRejectMailRegistrar } from './request-reject-mail.registrar';

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
    DueReminderMailRegistrar,
    CascadeCancelMailRegistrar,
    ForceCancelMailRegistrar,
    OffboardMailRegistrar,
    LicenseDigestMailRegistrar,
    EolDigestMailRegistrar,
    ExtensionMailRegistrar,
    RequestRejectMailRegistrar,
  ],
  controllers: [
    NotificationsController,
    SmtpConfigController,
    MailSettingsController,
  ],
  exports: [NotificationsConsumer],
})
export class NotificationsModule {}
