import { Module } from '@nestjs/common';
import { DepartmentsAdminController } from './departments-admin.controller';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';

// AuditWriterService toàn cục (AuditModule @Global) → không cần import ở đây.
@Module({
  controllers: [DepartmentsAdminController, DepartmentsController],
  providers: [DepartmentsService],
  exports: [DepartmentsService],
})
export class DepartmentsModule {}
