import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { AuditWriterService } from '../audit/audit-writer.service';
import { UsersService } from '../users/users.service';
import { JwtVerifierService } from './jwt-verifier.service';
import { OIDC_PROVIDER } from './oidc-provider';
import type { OidcProvider } from './oidc-provider';
import { Public } from './public.decorator';
import { SessionService } from './session.service';
import { SESSION_COOKIE } from './identity.guard';
import type { AuthedRequest } from './identity.guard';

const OIDC_TX_COOKIE = 'qlts_oidc_tx';

function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? 'http://localhost:8080';
}

function redirectUri(): string {
  return `${appBaseUrl()}/api/auth/callback`;
}

/** base64url(sha256(verifier)) — PKCE S256 */
function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Cờ Secure theo môi trường thật: https luôn bật; http chỉ localhost (browser
 * coi localhost là trustworthy). Deploy http trên LAN mà hardcode Secure →
 * browser drop cookie → login loop không lời giải thích.
 */
function cookieSecure(): boolean {
  const url = new URL(appBaseUrl());
  return (
    url.protocol === 'https:' ||
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1'
  );
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProvider,
    private readonly jwtVerifier: JwtVerifierService,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
    private readonly audit: AuditWriterService,
  ) {}

  @Public()
  @Get('login')
  async login(@Res() res: Response): Promise<void> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    const url = await this.oidc.buildAuthUrl({
      redirectUri: redirectUri(),
      state,
      codeChallenge: pkceChallenge(codeVerifier),
    });
    // Giao dịch OIDC tạm (10') — httpOnly, không chứa gì nhạy cảm ngoài verifier một lần
    res.cookie(OIDC_TX_COOKIE, JSON.stringify({ codeVerifier, state }), {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'lax', // callback là redirect cross-site từ PMH ID — Strict sẽ làm rơi cookie
      maxAge: 10 * 60 * 1000,
      path: '/api/auth',
    });
    res.redirect(url);
  }

  @Public()
  @Get('callback')
  async callback(
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const txRaw = (req.cookies as Record<string, string> | undefined)?.[
      OIDC_TX_COOKIE
    ];
    res.clearCookie(OIDC_TX_COOKIE, { path: '/api/auth' });
    try {
      if (!txRaw) {
        throw new Error(
          'Thiếu cookie giao dịch OIDC (hết hạn 10 phút hoặc cookie bị chặn)',
        );
      }
      const tx = JSON.parse(txRaw) as { codeVerifier: string; state: string };
      const currentUrl = new URL(req.originalUrl, appBaseUrl());
      const tokens = await this.oidc.exchangeCode({
        currentUrl,
        redirectUri: redirectUri(),
        codeVerifier: tx.codeVerifier,
        expectedState: tx.state,
      });
      // Verify OFFLINE (AD-8) — không tin token chưa kiểm chữ ký
      const verified = await this.jwtVerifier.verify(tokens.accessToken);
      await this.users.upsertFromClaims(verified.claims);
      const session = await this.sessions.create({
        userSub: verified.claims.sub,
        refreshToken: tokens.refreshToken,
        accessTokenExp: verified.expiresAt,
        claims: verified.claims,
      });
      res.cookie(SESSION_COOKIE, session.id, {
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: 'strict',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000, // đồng bộ mốc GC phiên 30 ngày
      });
      await this.audit.append({
        actor: verified.claims.sub,
        action: 'auth.login',
        objectType: 'session',
        objectId: session.id,
      });
      res.redirect('/');
    } catch (error) {
      await this.audit.append({
        actor: 'system',
        action: 'auth.login_failed',
        detail: { message: (error as Error).message },
      });
      // Callback là navigation của browser — trả JSON thô làm user kẹt trên
      // trang lỗi không đường về; redirect để FE hiện thông báo
      res.redirect('/?login=failed');
    }
  }

  @Get('me')
  me(@Req() req: AuthedRequest): Promise<{
    sub: string;
    fullName?: string;
    email?: string;
    role: string;
    devMode: boolean;
    csrfToken: string | null;
    permissions: { canLongTerm: boolean; canRecurring: boolean };
  }> {
    return this.buildMe(req);
  }

  private async buildMe(req: AuthedRequest) {
    const user = req.user;
    if (!user) {
      // IdentityGuard đã chặn — nhánh này chỉ để type-safety
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Chưa đăng nhập.',
      });
    }
    let csrfToken: string | null = null;
    if (user.sessionId) {
      const session = await this.sessions.find(user.sessionId);
      csrfToken = session?.csrfToken ?? null;
    }
    // 2 cờ quyền (1.6, FR-8): chỉ member có; admin/sa luôn false (không đi luồng mượn)
    const permissions =
      user.role === 'member'
        ? await this.users.getPermissions(user.sub)
        : { canLongTerm: false, canRecurring: false };
    return {
      sub: user.sub,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      devMode: user.devMode,
      csrfToken,
      permissions,
    };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const user = req.user;
    if (user?.sessionId) {
      // Hủy phiên SERVER-side + refresh_token đã lưu (party phiên 7 — không chỉ xóa cookie)
      await this.sessions.destroy(user.sessionId);
      await this.audit.append({
        actor: user.sub,
        action: 'auth.logout',
        objectType: 'session',
        objectId: user.sessionId,
      });
    }
    res.clearCookie(SESSION_COOKIE);
    const logoutUrl = await this.oidc.buildLogoutUrl(appBaseUrl());
    res.json({ ok: true, logoutUrl });
  }
}
