import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import { LoggerModule } from 'nestjs-pino';
import { UserThrottlerGuard } from './common/user-throttler.guard';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { AssetsModule } from './modules/assets/assets.module';
import { AuditModule } from './modules/audit/audit.module';
import { FilesModule } from './modules/files/files.module';
import { AuthModule } from './modules/auth/auth.module';
import { OidcModule } from './modules/auth/oidc.module';
import { SystemConfigModule } from './modules/config/config.module';
import { TicketsModule } from './modules/tickets/tickets.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        // request_id mỗi request (convention spine); nhận x-request-id từ nginx nếu có
        genReqId: (req) =>
          (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        // AD-13f: cấm in Authorization/cookie/token ra log
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
          ],
          censor: '[REDACTED]',
        },
        customProps: (req) => ({ request_id: (req as { id?: unknown }).id }),
        autoLogging: true,
        transport:
          process.env.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
    // Lưới an toàn chống OOM-DoS bởi admin (epic review 2): 300 req/phút/user;
    // endpoint nặng (import/export/upload) siết riêng bằng @Throttle tại chỗ
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 300 }],
    }),
    DatabaseModule,
    AssetsModule,
    AuditModule,
    FilesModule,
    OidcModule,
    AuthModule,
    SystemConfigModule,
    TicketsModule,
  ],
  controllers: [HealthController],
  // Đăng ký SAU AuthModule (imports xử lý trước providers) → chạy sau IdentityGuard,
  // req.user.sub sẵn sàng cho tracker per-user
  providers: [{ provide: APP_GUARD, useClass: UserThrottlerGuard }],
})
export class AppModule {}
