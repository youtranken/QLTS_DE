import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { AuthedRequest } from '../auth/identity.guard';
import { AuditWriterService } from './audit-writer.service';
import { AUDITED_KEY } from './audited.decorator';
import type { AuditedMeta } from './audited.decorator';

/**
 * Ghi audit cho route có @Audited — CHỈ khi handler thành công (AD-10).
 * Handler ném lỗi → không ghi. Writer tự catch lỗi ghi (không gãy nghiệp vụ).
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditWriterService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditedMeta | undefined>(
      AUDITED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!meta) {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const params = request.params as Record<string, string> | undefined;
    return next.handle().pipe(
      tap(() => {
        void this.audit.append({
          actor: request.user?.sub ?? 'system',
          action: meta.action,
          objectType: meta.objectType,
          objectId: params?.id,
          detail: { method: request.method, path: request.originalUrl },
        });
      }),
    );
  }
}
