import { Module } from '@nestjs/common';
import { CatalogAdminController } from './catalog.controller';
import { CatalogService } from './catalog.service';

// AuditWriterService toàn cục (AuditModule @Global) → không cần import ở đây.
@Module({
  controllers: [CatalogAdminController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
