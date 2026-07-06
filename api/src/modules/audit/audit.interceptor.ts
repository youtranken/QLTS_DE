import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import type { AuthedRequest } from '../auth/identity.guard';
import { AuditWriterService } from './audit-writer.service';
import { AUDITED_KEY } from './audited.decorator';
import type { AuditedMeta } from './audited.decorator';

/**
 * Ghi audit cho route có @Audited — CHỈ khi handler thành công (AD-10).
 * Handler ném lỗi → không ghi. AWAIT ghi xong mới trả response (không
 * fire-and-forget — process chết ngay sau response vẫn còn vết); writer tự
 * catch lỗi ghi nên không gãy nghiệp vụ.
 * Giới hạn ghi nhận: Observable nhiều emission chỉ audit lần emission đầu.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditWriterService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const meta = this.reflector.getAllAndOverride<AuditedMeta | undefined>(
      AUDITED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!meta) {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const params = request.params as Record<string, string> | undefined;
    let written = false;
    return next.handle().pipe(
      concatMap(async (value: unknown) => {
        if (!written) {
          written = true;
          await this.audit.append({
            actor: request.user?.sub ?? 'system',
            action: meta.action,
            objectType: meta.objectType,
            objectId: params?.id,
            // request.path (không phải originalUrl): tránh ghi query string
            // (token/email...) vào bảng không-xóa-được
            detail: { method: request.method, path: request.path },
          });
        }
        return value;
      }),
    );
  }
}
