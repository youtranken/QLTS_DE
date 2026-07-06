/**
 * Interface OIDC — wrap `openid-client` để e2e thay test-double qua DI
 * (quyết định cắt story 1.2: test tự động không cần PMH ID sống).
 */
export const OIDC_PROVIDER = 'OIDC_PROVIDER';

export interface OidcTokens {
  accessToken: string;
  refreshToken: string | null;
}

export interface AuthUrlRequest {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export interface CodeExchangeRequest {
  /** URL callback đầy đủ (kèm query code/state) */
  currentUrl: URL;
  redirectUri: string;
  codeVerifier: string;
  expectedState: string;
}

export interface OidcProvider {
  /** Ném lỗi nếu PMH ID không liên lạc được — đăng nhập MỚI fail-closed (AD-8). */
  buildAuthUrl(req: AuthUrlRequest): Promise<string>;
  exchangeCode(req: CodeExchangeRequest): Promise<OidcTokens>;
  /** Ném lỗi khi refresh token bị thu hồi/hết hạn — caller coi là đăng xuất. */
  refresh(refreshToken: string): Promise<OidcTokens>;
  /** null nếu provider không có end-session endpoint. */
  buildLogoutUrl(postLogoutRedirectUri: string): Promise<string | null>;
  /** Token M2M (client_credentials) cho Directory API — cache đến gần hết hạn.
   *  forceRefresh: bỏ cache (dùng khi token bị từ chối sớm hơn hạn). */
  clientCredentialsToken(forceRefresh?: boolean): Promise<string>;
}
