import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AssetsAdminController } from './assets-admin.controller';
import { AssetsService } from './assets.service';

/** Module assets (AD-1) — sổ tài sản; Epic 3 (Tickets) phụ thuộc chiều Tickets → Assets. */
@Module({
  imports: [AuditModule],
  controllers: [AssetsAdminController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
