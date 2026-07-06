import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DevIdentityGuard } from './dev-identity.guard';

@Module({
  providers: [{ provide: APP_GUARD, useClass: DevIdentityGuard }],
})
export class AuthModule {}
