import { Module } from '@nestjs/common';
import { ConfigAdminService } from './config-admin.service';
import { ConfigController } from './config.controller';
import { SystemConfigService } from './system-config.service';
import { SmtpConfigService } from './smtp-config.service';
import { MailSettingsService } from './mail-settings.service';

@Module({
  controllers: [ConfigController],
  providers: [
    SystemConfigService,
    ConfigAdminService,
    SmtpConfigService,
    MailSettingsService,
  ],
  exports: [SystemConfigService, SmtpConfigService, MailSettingsService],
})
export class SystemConfigModule {}
