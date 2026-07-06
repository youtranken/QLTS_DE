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
    return {
      claims: this.toClaims(payload),
      expiresAt: payload.exp ? new Date(payload.exp * 1000) : null,
    };
  }

  private toClaims(payload: JWTPayload): PmhIdClaims {
    return {
      sub: payload.sub as string,
      email: payload.email as string | undefined,
      employee_code: payload.employee_code as string | undefined,
      full_name: payload.full_name as string | undefined,
      groups: (payload.groups as string[] | undefined) ?? [],
    };
  }
}
