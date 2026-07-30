import { Module } from '@nestjs/common';
import { ConfigAdminService } from './config-admin.service';
import { ConfigController } from './config.controller';
import { SystemConfigService } from './system-config.service';
import { SmtpConfigService } from './smtp-config.service';

@Module({
  controllers: [ConfigController],
  providers: [SystemConfigService, ConfigAdminService, SmtpConfigService],
  exports: [SystemConfigService, SmtpConfigService],
})
export class SystemConfigModule {}
