import {
  BadRequestException,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuditWriterService } from '../audit/audit-writer.service';
import { JwtVerifierService } from './jwt-verifier.service';
import { Public } from './public.decorator';
import { SessionService } from './session.service';

/**
 * Back-Channel Logout (OIDC BCL — docs integration 4.7): PMH ID POST `logout_token`
 * (JWT ký, form-urlencoded) khi PHIÊN SSO kết thúc (user đăng xuất toàn hệ ở portal
 * hoặc admin khóa) → đá phiên QLTS TỨC THÌ thay vì chờ ≤5' token hết hạn.
 *
 * Bù cho local logout của QLTS: logout ở QLTS chỉ hủy phiên riêng (không đụng SSO),
 * nên global logout phải về qua kênh này. Bảo mật bằng CHỮ KÝ JWT (không HMAC như webhook).
 */
@Controller('backchannel-logout')
export class BackchannelLogoutController {
  private readonly logger = new Logger(BackchannelLogoutController.name);

  constructor(
    private readonly jwtVerifier: JwtVerifierService,
    private readonly sessions: SessionService,
    private readonly audit: AuditWriterService,
  ) {}

  @Public()
  @Post()
  @HttpCode(200)
  async handle(@Req() req: Request): Promise<{ ok: boolean }> {
    const token = (req.body as { logout_token?: unknown } | undefined)
      ?.logout_token;
    if (typeof token !== 'string') {
      throw new BadRequestException({
        code: 'LOGOUT_TOKEN_MISSING',
        message: 'Thiếu logout_token.',
      });
    }
    let sub: string;
    try {
      ({ sub } = await this.jwtVerifier.verifyLogoutToken(token));
    } catch (error) {
      // Chữ ký/claim sai → 400 (không 500): PMH ID coi là hỏng, không retry vô hạn
      this.logger.warn(`BCL từ chối: ${(error as Error).message}`);
      throw new BadRequestException({
        code: 'LOGOUT_TOKEN_INVALID',
        message: 'logout_token không hợp lệ.',
      });
    }
    const killed = await this.sessions.destroyAllForUser(sub);
    await this.audit.append({
      actor: 'system(bcl)',
      action: 'auth.session_revoked',
      objectType: 'user',
      objectId: sub,
      detail: { via: 'backchannel_logout', sessions_killed: killed },
    });
    return { ok: true };
  }
}
