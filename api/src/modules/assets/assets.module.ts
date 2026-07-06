import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SystemConfigModule } from '../config/config.module';
import { AssetsAdminController } from './assets-admin.controller';
import { AssetsService } from './assets.service';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

/** Module assets (AD-1) — sổ tài sản; Epic 3 (Tickets) phụ thuộc chiều Tickets → Assets. */
@Module({
  imports: [AuditModule, SystemConfigModule],
  controllers: [AssetsAdminController, ImportController],
  providers: [AssetsService, ImportService],
  exports: [AssetsService],
})
export class AssetsModule {}
