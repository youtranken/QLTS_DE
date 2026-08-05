import { Global, Module } from '@nestjs/common';
import { JwtVerifierService } from './jwt-verifier.service';
import { OIDC_PROVIDER } from './oidc-provider';
import { OpenidClientProvider } from './openid-client.provider';

/**
 * Cung cấp OIDC_PROVIDER + JwtVerifier dùng chung (auth login/refresh, users
 * directory-sync) — tách khỏi AuthModule để tránh vòng AuthModule ↔ UsersModule.
 */
@Global()
@Module({
  providers: [
    { provide: OIDC_PROVIDER, useClass: OpenidClientProvider },
    JwtVerifierService,
  ],
  exports: [OIDC_PROVIDER, JwtVerifierService],
})
export class OidcModule {}
