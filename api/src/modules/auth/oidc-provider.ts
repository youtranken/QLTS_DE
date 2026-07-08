/**
 * Interface OIDC — wrap `openid-client` để e2e thay test-double qua DI
 * (quyết định cắt story 1.2: test tự động không cần PMH ID sống).
 */
export const OIDC_PROVIDER = 'OIDC_PROVIDER';

export interface OidcTokens {
  accessToken: string;
  refreshToken: string | null;
  /** id_token — giữ để làm id_token_hint khi logout (bai-hoc-sso #5). null nếu IdP không phát. */
  idToken: string | null;
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
  /** null nếu provider không có end-session endpoint. `idTokenHint` giúp IdP nhận diện phiên
   *  → logout gọn, không trang lỗi kể cả khi phiên đã kết thúc (bai-hoc-sso #5). */
  buildLogoutUrl(
    postLogoutRedirectUri: string,
    idTokenHint?: string | null,
  ): Promise<string | null>;
  /** Token M2M (client_credentials) cho Directory API — cache đến gần hết hạn.
   *  forceRefresh: bỏ cache (dùng khi token bị từ chối sớm hơn hạn). */
  clientCredentialsToken(forceRefresh?: boolean): Promise<string>;
}
