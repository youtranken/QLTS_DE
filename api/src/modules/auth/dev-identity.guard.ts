import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { isDevAuthActive } from './auth-env';

export const DEV_SUB_HEADER = 'x-dev-user-sub';
export const DEV_ROLE_HEADER = 'x-dev-role';

const DEV_ROLES = ['member', 'admin', 'sa'] as const;
export type DevRole = (typeof DEV_ROLES)[number];

export interface RequestIdentity {
  sub: string;
  role: DevRole;
  devMode: boolean;
}

/**
 * Guard toàn cục GẮN identity giả từ header test khi AUTH_DEV_MODE active.
 * Không CHẶN request — enforce vai là việc của RolesGuard (story 1.5).
 * Story 1.2 thay nguồn identity bằng session PMH ID; header test giữ nguyên cho test.
 */
@Injectable()
export class DevIdentityGuard implements CanActivate {
  private readonly active = isDevAuthActive(process.env);

  canActivate(context: ExecutionContext): boolean {
    if (!this.active) {
      return true;
    }
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: RequestIdentity }>();
    const sub = request.headers[DEV_SUB_HEADER];
    const role = request.headers[DEV_ROLE_HEADER];
    if (
      typeof sub === 'string' &&
      sub.length > 0 &&
      typeof role === 'string' &&
      (DEV_ROLES as readonly string[]).includes(role)
    ) {
      request.user = { sub, role: role as DevRole, devMode: true };
    }
    return true;
  }
}
