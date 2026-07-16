import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { AuditWriterService } from '../audit/audit-writer.service';
import { SystemConfigService } from '../config/system-config.service';
import { AuthorizedGroupsService } from '../users/authorized-groups.service';
import { UsersService } from '../users/users.service';
import { intersectsCI } from './group-access';
import { JwtVerifierService } from './jwt-verifier.service';
import { LOCAL_SA_SUB } from './local-sa-env';
import { LocalSaService } from './local-sa.service';
import { OIDC_PROVIDER } from './oidc-provider';
import type { OidcProvider } from './oidc-provider';
import { Public } from './public.decorator';
import { SessionService } from './session.service';
import { SESSION_COOKIE } from './identity.guard';
import type { AuthedRequest } from './identity.guard';

class SaLoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  username!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  password!: string;
}

/**
 * IP client cho lockout SA login. Dùng `req.ip` — với `trust proxy=1` (app.setup),
 * Express lấy entry X-Forwarded-For do nginx THÊM (client thật, bên phải), KHÔNG phải
 * entry trái do client tự đặt. Tự parse XFF-trái sẽ để attacker đổi header mỗi request
 * → mỗi lần thử thành "IP khác" → khoá 5-lần/IP vô hiệu. Một nguồn với UserThrottlerGuard.
 */
function clientIp(req: AuthedRequest): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

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
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(OIDC_PROVIDER) private readonly oidc: OidcProvider,
    private readonly jwtVerifier: JwtVerifierService,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
    private readonly audit: AuditWriterService,
    private readonly localSa: LocalSaService,
    private readonly authorizedGroups: AuthorizedGroupsService,
    private readonly config: SystemConfigService,
  ) {}

  /**
   * Đăng nhập SA cục bộ (break-glass, story 10.1): username/password từ env, KHÔNG SSO.
   * Đúng → phiên `role=sa`. Sai → 401 mơ hồ. 5 sai/IP → 429 khoá 15'. Không log password.
   */
  @Public()
  @Post('sa-login')
  @HttpCode(200)
  async saLogin(
    @Body() dto: SaLoginDto,
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const ip = clientIp(req);
    const result = this.localSa.attemptLogin(dto.username, dto.password, ip);
    if (result !== 'ok') {
      await this.audit.append({
        actor: 'system',
        action: 'auth.sa_login_failed',
        detail: { ip, reason: result },
      });
      if (result === 'locked') {
        throw new HttpException(
          {
            code: 'SA_LOGIN_LOCKED',
            message: 'Quá nhiều lần sai — tạm khoá đăng nhập SA. Thử lại sau ít phút.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new UnauthorizedException({
        code: 'SA_LOGIN_INVALID',
        message: 'Sai tài khoản hoặc mật khẩu.',
      });
    }
    // Bảo đảm SA có users row (thoả FK created_by_sub khi SA tạo-hộ) — SA vẫn vô hình
    // ở màn Quản trị/picker (list() loại LOCAL_SA_SUB). Idempotent mỗi lần login.
    await this.users.ensureLocalSa();
    const session = await this.sessions.createLocalSa();
    res.cookie(SESSION_COOKIE, session.id, {
      httpOnly: true,
      secure: cookieSecure(),
      sameSite: 'strict',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    await this.audit.append({
      actor: LOCAL_SA_SUB,
      action: 'auth.sa_login',
      objectType: 'session',
      objectId: session.id,
      detail: { ip },
    });
    res.json({ ok: true });
  }

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

  /**
   * "Đăng nhập bằng tài khoản khác" (dùng ở trang ?login=forbidden): kết thúc PHIÊN SSO ở
   * PMH ID (end_session) rồi để auto-SSO đưa tới FORM login. Bắt buộc qua PMH ID vì QLTS
   * không tự hủy phiên SSO được. @Public: user bị chặn KHÔNG có phiên QLTS; nếu tình cờ
   * còn phiên (user chủ động đổi) → hủy local + dùng id_token làm hint cho logout gọn.
   */
  @Public()
  @Get('switch-account')
  async switchAccount(
    @Req() req: AuthedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const sid = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ];
    let idTokenHint: string | null = null;
    if (sid) {
      const session = await this.sessions.find(sid);
      idTokenHint = session?.idToken ?? null;
      await this.sessions.destroy(sid);
    }
    res.clearCookie(SESSION_COOKIE);
    // post_logout_redirect_uri PHẢI khớp hệt app_url (docs integration 4.5)
    const logoutUrl = await this.oidc.buildLogoutUrl(appBaseUrl(), idTokenHint);
    // Có end-session → PMH ID hủy phiên SSO → về app_url → auto-SSO → form login.
    // KHÔNG có (IdP chưa cấu hình end_session) → KHÔNG đẩy về /api/auth/login: phiên SSO còn
    // sống sẽ silent re-auth ra access_denied → lặp forbidden (review P4). Về trang lỗi terminal
    // (login=failed chặn auto-SSO) để user không kẹt vòng lặp.
    res.redirect(logoutUrl ?? '/?login=failed');
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
      const currentUrl = new URL(req.originalUrl, appBaseUrl());
      // Cookie giao dịch bắt buộc — chặn callback ẩn danh (không round-trip thật) spam/forge
      // audit + điều khiển thông báo bảo mật (review P2). Đặt TRƯỚC nhánh xử lý `?error`.
      if (!txRaw) {
        throw new Error(
          'Thiếu cookie giao dịch OIDC (hết hạn 10 phút hoặc cookie bị chặn)',
        );
      }
      // PMH ID từ chối NGAY ở IdP: callback nhận `?error=` thay vì `?code=` (README mục 4).
      // `access_denied` = user bị xóa/khóa/GỠ khỏi group được cấp — KHÔNG phải lỗi hệ thống →
      // báo "không có quyền" thay vì "thử lại". error/error_description cắt ngắn để không phình audit.
      const idpError = currentUrl.searchParams.get('error');
      if (idpError) {
        const denied = idpError === 'access_denied';
        await this.audit.append({
          actor: 'system',
          action: denied ? 'auth.login_denied_idp' : 'auth.login_failed',
          detail: {
            error: idpError.slice(0, 100),
            error_description:
              currentUrl.searchParams.get('error_description')?.slice(0, 200) ??
              null,
          },
        });
        res.redirect(denied ? '/?login=forbidden' : '/?login=failed');
        return;
      }
      const tx = JSON.parse(txRaw) as { codeVerifier: string; state: string };
      const tokens = await this.oidc.exchangeCode({
        currentUrl,
        redirectUri: redirectUri(),
        codeVerifier: tx.codeVerifier,
        expectedState: tx.state,
      });
      // Verify OFFLINE (AD-8) — không tin token chưa kiểm chữ ký
      const verified = await this.jwtVerifier.verify(tokens.accessToken);

      // Gate access theo group (10.2): danh sách được phép LẤY ĐỘNG từ PMH ID (directory-sync
      // ghi vào config). Rỗng = chưa biết → gate TẮT (fail-open trước lần sync đầu, AC4).
      let allowedGroups = await this.authorizedGroups.current();
      if (allowedGroups.length === 0) {
        // AC4: gate tắt cần quan sát được — WARN mỗi login để vận hành biết đang chạy KHÔNG gate.
        this.logger.warn(
          'authorized_groups rỗng — gate group TẮT: mọi tài khoản SSO hợp lệ vào được. Chạy directory-sync để bật gate.',
        );
      } else if (!intersectsCI(verified.claims.groups, allowedGroups)) {
        // Self-heal (10.3): admin có thể vừa gán group mới cho client mà authorized_groups
        // chưa kịp sync → fetch tươi 1 lần (cache TTL chống lạm dụng) rồi kiểm lại trước khi chặn.
        allowedGroups = await this.authorizedGroups.refreshForLogin();
        if (!intersectsCI(verified.claims.groups, allowedGroups)) {
          await this.audit.append({
            actor: verified.claims.sub,
            action: 'auth.login_denied_group',
            detail: {
              groups: verified.claims.groups ?? [],
              allowed: allowedGroups,
              // AC6: phân biệt token thiếu groups vs groups không khớp danh sách
              reason:
                (verified.claims.groups?.length ?? 0) === 0
                  ? 'missing_groups'
                  : 'no_match',
            },
          });
          res.redirect('/?login=forbidden');
          return;
        }
      }

      await this.users.upsertFromClaims(verified.claims);
      const session = await this.sessions.create({
        userSub: verified.claims.sub,
        refreshToken: tokens.refreshToken,
        accessTokenExp: verified.expiresAt,
        claims: verified.claims,
        idToken: tokens.idToken,
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
    workingHours: { days: number[]; start: string; end: string };
    autoApproveMaxHours: number;
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
    // Giờ làm + ngưỡng auto-duyệt để FORM ĐẶT MÁY (member) theo config SA chỉnh, không hardcode
    // (audit H2/H3). Cache 30s trong SystemConfigService nên rẻ; mọi vai đều cần cho popup mượn.
    const wh = await this.config.getWorkingHours();
    const autoApproveMaxHours = await this.config.getAutoApproveMaxHours();
    return {
      sub: user.sub,
      fullName: user.fullName,
      email: user.email,
      role: user.role,
      devMode: user.devMode,
      csrfToken,
      permissions,
      workingHours: { days: wh.days, start: wh.start, end: wh.end },
      autoApproveMaxHours,
    };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const user = req.user;
    if (user?.sessionId) {
      // Hủy phiên SERVER-side + refresh_token đã lưu (không chỉ xóa cookie)
      await this.sessions.destroy(user.sessionId);
      await this.audit.append({
        actor: user.sub,
        action: 'auth.logout',
        objectType: 'session',
        objectId: user.sessionId,
      });
    }
    res.clearCookie(SESSION_COOKIE);
    // LOCAL logout: chỉ rời QLTS, KHÔNG gọi end_session của IdP. end_session kết thúc
    // phiên SSO DÙNG CHUNG → portal id.pmh.com.vn + mọi project khác mất đăng nhập.
    // QLTS là RP dưới portal: đăng xuất 1 project không được đá người dùng khỏi portal.
    // Muốn thoát hẳn toàn hệ thống → đăng xuất ở portal. FE chặn auto-relogin sau logout.
    res.json({ ok: true });
  }
}
