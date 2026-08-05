import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { SessionService } from './session.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { AuthedRequest } from './identity.guard';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Anti-CSRF (AC 2): route mutate với identity TỪ PHIÊN cookie phải gửi
 * header `X-CSRF-Token` khớp `sessions.csrf_token`.
 * - Identity dev-header (AUTH_DEV_MODE): KHÔNG cần CSRF — không có cookie thì không có CSRF risk.
 * - Route @Public() (webhook — bảo vệ bằng HMAC riêng): bỏ qua.
 * Chạy SAU IdentityGuard (đăng ký sau trong providers).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!MUTATING_METHODS.has(request.method)) {
      return true;
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const sessionId = request.user?.sessionId;
    if (!sessionId) {
      // identity dev-header hoặc không đăng nhập (IdentityGuard đã xử 401)
      return true;
    }
    const token = request.headers['x-csrf-token'];
    if (typeof token === 'string' && token.length > 0) {
      const session = await this.sessions.find(sessionId);
      if (session && this.tokensMatch(session.csrfToken, token)) {
        return true;
      }
    }
    throw new ForbiddenException({
      code: 'CSRF_TOKEN_INVALID',
      message: 'Thiếu hoặc sai CSRF token — tải lại trang rồi thử lại.',
    });
  }

  private tokensMatch(expected: string, provided: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
