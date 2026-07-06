import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { CsrfGuard } from './csrf.guard';
import { IdentityGuard } from './identity.guard';
import { RolesGuard } from './roles.guard';
import { SessionAuthService } from './session-auth.service';
import { SessionService } from './session.service';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [UsersModule],
  controllers: [AuthController, WebhookController],
  providers: [
    SessionService,
    SessionAuthService,
    // Thứ tự guard toàn cục: Identity → CSRF → Roles (Roles cần req.user)
    { provide: APP_GUARD, useClass: IdentityGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [SessionService],
})
export class AuthModule {}
