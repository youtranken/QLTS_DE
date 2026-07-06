import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './audit.interceptor';
import { AuditWriterService } from './audit-writer.service';

@Global()
@Module({
  providers: [
    AuditWriterService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditWriterService],
})
export class AuditModule {}
