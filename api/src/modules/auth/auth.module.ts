import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { CsrfGuard } from './csrf.guard';
import { IdentityGuard } from './identity.guard';
import { JwtVerifierService } from './jwt-verifier.service';
import { OIDC_PROVIDER } from './oidc-provider';
import { OpenidClientProvider } from './openid-client.provider';
import { SessionAuthService } from './session-auth.service';
import { SessionService } from './session.service';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [UsersModule],
  controllers: [AuthController, WebhookController],
  providers: [
    SessionService,
    SessionAuthService,
    JwtVerifierService,
    { provide: OIDC_PROVIDER, useClass: OpenidClientProvider },
    // Thứ tự guard toàn cục: Identity trước, CSRF sau (CSRF cần req.user.sessionId)
    { provide: APP_GUARD, useClass: IdentityGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  exports: [SessionService, JwtVerifierService],
})
export class AuthModule {}
