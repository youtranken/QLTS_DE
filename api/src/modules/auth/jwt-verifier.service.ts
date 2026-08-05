import { Injectable } from '@nestjs/common';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import type { PmhIdClaims } from '../users/users.service';

export interface VerifiedAccessToken {
  claims: PmhIdClaims;
  /** thời điểm hết hạn (từ `exp` — QLTS không hardcode TTL, AD-8) */
  expiresAt: Date | null;
}

/**
 * Verify access token JWT RS256 OFFLINE qua JWKS (AD-8):
 * cache ≤10 phút, chọn khóa theo `kid` (jose tự làm), clockTolerance ±60s.
 * KHÔNG gọi PMH ID mỗi request.
 */
@Injectable()
export class JwtVerifierService {
  private jwks: JWTVerifyGetKey | null = null;
  private jwksUrl: string | null = null;
  private pinned = false;

  /** Cho test: bơm JWKS local (key tự sinh) thay vì remote — thắng mọi cache. */
  setKeySource(getKey: JWTVerifyGetKey): void {
    this.jwks = getKey;
    this.pinned = true;
  }

  private async getKeySource(): Promise<JWTVerifyGetKey> {
    if (this.pinned && this.jwks) {
      return this.jwks;
    }
    // Issuer `.../oidc` → JWKS `.../oidc/jwks` (docs integration mục 3)
    const url = `${process.env.PMH_ISSUER_URL}/jwks`;
    if (this.jwks && this.jwksUrl === url) {
      return this.jwks;
    }
    const jose = await import('jose');
    this.jwks = jose.createRemoteJWKSet(new URL(url), {
      cacheMaxAge: 10 * 60 * 1000, // ≤10 phút (AD-8)
    });
    this.jwksUrl = url;
    return this.jwks;
  }

  async verify(accessToken: string): Promise<VerifiedAccessToken> {
    const jose = await import('jose');
    const getKey = await this.getKeySource();
    const { payload } = await jose.jwtVerify(accessToken, getKey, {
      issuer: process.env.PMH_ISSUER_URL,
      audience: process.env.PMH_CLIENT_ID,
      clockTolerance: 60, // ±60s chống 401 chập chờn do lệch đồng hồ (party phiên 7)
    });
    // Hợp đồng ver:1 bắt buộc sub + exp — token thiếu là token hỏng, reject từ gốc
    // (thiếu sub → identity undefined; thiếu exp → refresh mỗi request)
    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new Error('Access token thiếu claim `sub`');
    }
    if (!payload.exp) {
      throw new Error('Access token thiếu claim `exp`');
    }
    return {
      claims: this.toClaims(payload),
      expiresAt: new Date(payload.exp * 1000),
    };
  }

  /**
   * Verify logout_token của Back-Channel Logout (OIDC BCL, docs integration 4.7):
   * cùng JWKS/issuer/audience như access token, nhưng BẮT BUỘC có claim `events`
   * backchannel-logout và KHÔNG có `nonce` (phân biệt với id_token bị dùng nhầm).
   */
  async verifyLogoutToken(logoutToken: string): Promise<{ sub: string }> {
    const jose = await import('jose');
    const getKey = await this.getKeySource();
    const { payload } = await jose.jwtVerify(logoutToken, getKey, {
      issuer: process.env.PMH_ISSUER_URL,
      audience: process.env.PMH_CLIENT_ID,
      clockTolerance: 60,
    });
    const events = payload.events as Record<string, unknown> | undefined;
    const isLogout =
      !!events &&
      'http://schemas.openid.net/event/backchannel-logout' in events;
    if (!isLogout || 'nonce' in payload) {
      throw new Error(
        'Không phải logout_token hợp lệ (thiếu events backchannel-logout hoặc có nonce)',
      );
    }
    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new Error('logout_token thiếu claim `sub`');
    }
    // Bắt buộc `exp`: jose chỉ enforce hết hạn NẾU claim có mặt; thiếu `exp` → token
    // replay được vô thời hạn để đá phiên nạn nhân (review P0 3.4). Chống replay trong
    // cửa sổ còn hạn (dedup `jti`) là việc bổ sung — cần bảng dedup (nợ đã ghi).
    if (!payload.exp) {
      throw new Error('logout_token thiếu claim `exp`');
    }
    return { sub: payload.sub };
  }

  private toClaims(payload: JWTPayload): PmhIdClaims {
    return {
      sub: payload.sub as string,
      email: payload.email as string | undefined,
      employee_code: payload.employee_code as string | undefined,
      full_name: payload.full_name as string | undefined,
      department: payload.department as string | undefined,
      groups: (payload.groups as string[] | undefined) ?? [],
    };
  }
}
