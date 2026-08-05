import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { isDevAuthActive } from './auth-env';
import { SessionAuthService } from './session-auth.service';
import { IS_PUBLIC_KEY } from './public.decorator';

export const DEV_SUB_HEADER = 'x-dev-user-sub';
export const DEV_ROLE_HEADER = 'x-dev-role';
export const SESSION_COOKIE = 'qlts_sid';

const DEV_ROLES = ['member', 'admin', 'sa'] as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type DevRole = (typeof DEV_ROLES)[number];

export interface RequestIdentity {
  sub: string;
  role: string;
  devMode: boolean;
  /** id phiên — chỉ có khi identity đến từ session OIDC */
  sessionId?: string;
  fullName?: string;
  email?: string;
}

export type AuthedRequest = Request & {
  user?: RequestIdentity;
  cookies?: Record<string, string>;
};

/**
 * Guard identity hợp nhất (story 1.2, thay DevIdentityGuard 1.1):
 * 1. AUTH_DEV_MODE active + header test hợp lệ → identity dev (seam 1.1 GIỮ NGUYÊN)
 * 2. Cookie phiên → session OIDC (tự refresh ngầm; refresh fail → hủy phiên)
 * 3. Không identity + route không @Public() → 401 UNAUTHENTICATED (default-secure)
 */
@Injectable()
export class IdentityGuard implements CanActivate {
  private readonly logger = new Logger(IdentityGuard.name);
  private readonly devActive = isDevAuthActive(process.env);

  constructor(
    private readonly reflector: Reflector,
    private readonly sessionAuth: SessionAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    // (1) Seam dev-identity — hành vi 1.1 giữ nguyên
    if (this.devActive) {
      const sub = request.headers[DEV_SUB_HEADER];
      const role = request.headers[DEV_ROLE_HEADER];
      if (
        typeof sub === 'string' &&
        sub.length > 0 &&
        typeof role === 'string' &&
        (DEV_ROLES as readonly string[]).includes(role)
      ) {
        request.user = { sub, role, devMode: true };
        return true;
      }
    }

    // (2) Phiên OIDC — validate uuid TRƯỚC khi chạm DB (cookie rác 'abc' sẽ làm
    // Postgres ném 22P02 trên cột uuid → 500 lặp vô hạn, user kẹt tới khi tự xóa cookie)
    const rawSessionId = (
      request.cookies as Record<string, string> | undefined
    )?.[SESSION_COOKIE];
    const sessionId =
      rawSessionId && UUID_PATTERN.test(rawSessionId) ? rawSessionId : null;
    if (rawSessionId && !sessionId) {
      response.clearCookie(SESSION_COOKIE);
    }
    if (sessionId) {
      const identity = await this.sessionAuth.resolve(sessionId);
      if (identity) {
        request.user = identity;
        return true;
      }
      // Phiên chết (hết hạn/revoke) → dọn cookie
      response.clearCookie(SESSION_COOKIE);
    }

    // (3) Default-secure
    if (isPublic) {
      return true;
    }
    throw new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: 'Chưa đăng nhập hoặc phiên đã hết hạn — vui lòng đăng nhập lại.',
    });
  }
}
