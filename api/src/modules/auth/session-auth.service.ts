import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuditWriterService } from '../audit/audit-writer.service';
import { UsersService } from '../users/users.service';
import { JwtVerifierService } from './jwt-verifier.service';
import {
  LOCAL_SA_EMAIL,
  LOCAL_SA_FULL_NAME,
  LOCAL_SA_IDLE_MS,
  LOCAL_SA_SUB,
} from './local-sa-env';
import { OIDC_PROVIDER } from './oidc-provider';
import type { OidcProvider } from './oidc-provider';
import { SessionService } from './session.service';
import type { SessionRecord } from './session.service';
import type { RequestIdentity } from './identity.guard';
import type { PmhIdClaims } from '../users/users.service';

/**
 * Phân giải phiên → identity, kèm refresh ngầm (AC 4):
 * - access token còn hạn (đọc `exp` đã lưu) → dùng claims trong session
 * - hết hạn → refresh qua PMH ID, verify token mới offline, cập nhật session
 * - refresh bị TỪ CHỐI (invalid_grant — revoke/idle) → hủy phiên + audit → null (guard 401)
 * - PMH ID SẬP/không phân loại được → GIỮ NGUYÊN phiên, ném 503 (user thử lại sau —
 *   không biến outage tạm thời thành logout vĩnh viễn)
 * - SINGLE-FLIGHT theo session: N request song song (nhiều tab) chỉ refresh MỘT lần —
 *   tránh đốt refresh token xoay vòng single-use rồi logout oan
 */
@Injectable()
export class SessionAuthService {
  private readonly logger = new Logger(SessionAuthService.name);
  private readonly inflight = new Map<
    string,
    Promise<RequestIdentity | null>
  >();

  constructor(
    private readonly sessions: SessionService,
    private readonly jwtVerifier: JwtVerifierService,
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProvider,
    private readonly audit: AuditWriterService,
    private readonly users: UsersService,
  ) {}

  resolve(sessionId: string): Promise<RequestIdentity | null> {
    const existing = this.inflight.get(sessionId);
    if (existing) {
      return existing;
    }
    // Đặt vào map ĐỒNG BỘ trước mọi await — đóng cửa sổ race giữa get và set
    const promise = this.doResolve(sessionId).finally(() =>
      this.inflight.delete(sessionId),
    );
    this.inflight.set(sessionId, promise);
    return promise;
  }

  private async doResolve(sessionId: string): Promise<RequestIdentity | null> {
    const session = await this.sessions.find(sessionId);
    if (!session) {
      return null;
    }

    // Phiên SA local (break-glass): không có claims OIDC, KHÔNG refresh — xử lý
    // TRƯỚC nhánh claims. TTL idle ngắn (AC7): quá 2h không hoạt động → buộc login lại.
    if (session.userSub === LOCAL_SA_SUB) {
      const idleMs = Date.now() - session.lastSeenAt.getTime();
      if (idleMs > LOCAL_SA_IDLE_MS) {
        await this.expire(sessionId, LOCAL_SA_SUB, 'local_sa_idle');
        return null;
      }
      await this.sessions.touchLastSeen(sessionId);
      return {
        sub: LOCAL_SA_SUB,
        role: 'sa',
        devMode: false,
        sessionId,
        fullName: LOCAL_SA_FULL_NAME,
        email: LOCAL_SA_EMAIL,
      };
    }

    if (!session.claims) {
      return null;
    }

    const stillValid =
      session.accessTokenExp !== null &&
      session.accessTokenExp.getTime() > Date.now();

    if (stillValid) {
      return this.toIdentity(sessionId, session.claims);
    }
    return this.refreshSession(sessionId, session);
  }

  private async refreshSession(
    sessionId: string,
    session: SessionRecord,
  ): Promise<RequestIdentity | null> {
    if (!session.refreshToken) {
      await this.expire(sessionId, session.userSub, 'no_refresh_token');
      return null;
    }
    try {
      const tokens = await this.oidc.refresh(session.refreshToken);
      const verified = await this.jwtVerifier.verify(tokens.accessToken);
      const updated = await this.sessions.updateTokens(sessionId, {
        refreshToken: tokens.refreshToken,
        accessTokenExp: verified.expiresAt,
        claims: verified.claims,
        // refresh có thể không phát id_token mới → giữ cái lúc login (đủ làm hint)
        idToken: tokens.idToken ?? session.idToken,
      });
      if (!updated) {
        // Phiên bị xóa giữa chừng (webhook đá) — không xác thực bằng dữ liệu đã chết
        return null;
      }
      return this.toIdentity(sessionId, verified.claims);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        // SSO_NOT_CONFIGURED / SSO_UNAVAILABLE từ provider — GIỮ phiên
        throw error;
      }
      if (this.isRevocation(error)) {
        // Refresh bị PMH ID TỪ CHỐI = revoke/hết idle → đăng xuất (NFR-11)
        this.logger.log(
          `Refresh bị từ chối cho phiên ${sessionId}: ${(error as Error).message}`,
        );
        await this.expire(sessionId, session.userSub, 'refresh_failed');
        return null;
      }
      // Lỗi mạng/không phân loại được — coi như PMH ID sập: giữ phiên, 503
      this.logger.warn(
        `Refresh lỗi không phân loại (giữ phiên ${sessionId}): ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException({
        code: 'SSO_UNAVAILABLE',
        message: 'Không liên lạc được PMH ID — vui lòng thử lại sau.',
      });
    }
  }

  /** openid-client ném ResponseBodyError có `error` OAuth; fallback theo message. */
  private isRevocation(error: unknown): boolean {
    const oauthCode = (error as { error?: unknown }).error;
    if (typeof oauthCode === 'string') {
      return ['invalid_grant', 'invalid_token', 'unauthorized_client'].includes(
        oauthCode,
      );
    }
    return /invalid_grant|invalid_token|revoked|expired/i.test(
      (error as Error).message ?? '',
    );
  }

  /**
   * Vai từ phiên SSO: đọc users.role MỖI REQUEST — bổ nhiệm hiệu lực ngay, không
   * cần đăng nhập lại (story 1.5). 'sa' KHÔNG BAO GIỜ đến từ SSO nữa (story 10.1):
   * SA chỉ là tài khoản local (phiên `local:sa` xử lý ở doResolve). CLAMP 'sa' khỏi
   * bảng users giữ nguyên — DB CHECK 0007 là lớp thứ hai.
   */
  private async toIdentity(
    sessionId: string,
    claims: PmhIdClaims,
  ): Promise<RequestIdentity> {
    const user = await this.users.findBySub(claims.sub);
    const role = user?.role === 'admin' ? 'admin' : 'member';
    return {
      sub: claims.sub,
      role,
      devMode: false,
      sessionId,
      fullName: claims.full_name,
      email: claims.email,
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
