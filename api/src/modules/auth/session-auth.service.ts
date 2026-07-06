import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditWriterService } from '../audit/audit-writer.service';
import { JwtVerifierService } from './jwt-verifier.service';
import { OIDC_PROVIDER } from './oidc-provider';
import type { OidcProvider } from './oidc-provider';
import { SessionService } from './session.service';
import type { RequestIdentity } from './identity.guard';

/**
 * Phân giải phiên → identity, kèm refresh ngầm (AC 4):
 * - access token còn hạn (đọc `exp` đã lưu) → dùng claims trong session
 * - hết hạn → refresh qua PMH ID, verify token mới offline, cập nhật session
 * - refresh THẤT BẠI (revoke/idle) → hủy phiên + audit → trả null (guard sẽ 401)
 */
@Injectable()
export class SessionAuthService {
  private readonly logger = new Logger(SessionAuthService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly jwtVerifier: JwtVerifierService,
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProvider,
    private readonly audit: AuditWriterService,
  ) {}

  async resolve(sessionId: string): Promise<RequestIdentity | null> {
    const session = await this.sessions.find(sessionId);
    if (!session || !session.claims) {
      return null;
    }

    const stillValid =
      session.accessTokenExp !== null &&
      session.accessTokenExp.getTime() > Date.now();

    if (!stillValid) {
      if (!session.refreshToken) {
        await this.expire(sessionId, session.userSub, 'no_refresh_token');
        return null;
      }
      try {
        const tokens = await this.oidc.refresh(session.refreshToken);
        const verified = await this.jwtVerifier.verify(tokens.accessToken);
        await this.sessions.updateTokens(sessionId, {
          refreshToken: tokens.refreshToken,
          accessTokenExp: verified.expiresAt,
          claims: verified.claims,
        });
        session.claims = verified.claims;
      } catch (error) {
        // Refresh fail = tín hiệu revoke/phiên PMH ID hết idle → đăng xuất (NFR-11)
        this.logger.log(
          `Refresh thất bại cho phiên ${sessionId}: ${(error as Error).message}`,
        );
        await this.expire(sessionId, session.userSub, 'refresh_failed');
        return null;
      }
    }

    return {
      sub: session.claims.sub,
      role: 'member', // vai thật đọc từ users ở story 1.5 (RolesGuard)
      devMode: false,
      sessionId,
      fullName: session.claims.full_name,
      email: session.claims.email,
    };
  }

  private async expire(
    sessionId: string,
    userSub: string,
    reason: string,
  ): Promise<void> {
    await this.sessions.destroy(sessionId);
    await this.audit.append({
      actor: userSub,
      action: 'auth.session_expired',
      objectType: 'session',
      objectId: sessionId,
      detail: { reason },
    });
  }
}
