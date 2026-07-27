import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SystemConfigModule } from '../config/config.module';
import { AssetsAdminController } from './assets-admin.controller';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { AssetsService } from './assets.service';
import { AssetsLifecycleService } from './assets-lifecycle.service';
import { AssetsReadService } from './assets-read.service';
import { AssetSoftwareService } from './asset-software.service';
import { AssetExportService } from './asset-export.service';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { LicenseDigestService } from './license-digest.service';
import { AssetsSweepRegistrar } from './assets-sweep.registrar';

/** Module assets (AD-1) — sổ tài sản; Epic 3 (Tickets) phụ thuộc chiều Tickets → Assets. */
@Module({
  imports: [AuditModule, SystemConfigModule],
  controllers: [AssetsAdminController, ImportController, MeController],
  providers: [
    AssetsService,
    AssetsReadService,
    AssetsLifecycleService,
    MeService,
    AssetSoftwareService,
    AssetExportService,
    ImportService,
    LicenseDigestService,
    AssetsSweepRegistrar,
  ],
  exports: [AssetsService, AssetSoftwareService],
})
export class AssetsModule {}
