import { Module } from '@nestjs/common';
import { ConfigAdminService } from './config-admin.service';
import { ConfigController } from './config.controller';
import { SystemConfigService } from './system-config.service';

@Module({
  controllers: [ConfigController],
  providers: [SystemConfigService, ConfigAdminService],
  exports: [SystemConfigService],
})
export class SystemConfigModule {}
