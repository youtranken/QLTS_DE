import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

/** Module file dùng chung (2.8, AD-6) — Epic 3 dùng lại cho ảnh giao-nhận. */
@Module({
  imports: [AuditModule],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
