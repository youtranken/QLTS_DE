import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FilesController, InventoryController } from './files.controller';
import { FilesService } from './files.service';

/** Module file dùng chung (2.8, AD-6) — Epic 3 dùng lại cho ảnh giao-nhận. */
@Module({
  imports: [AuditModule],
  controllers: [FilesController, InventoryController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
