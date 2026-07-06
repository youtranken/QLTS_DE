import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import {
  runMigrations,
  resolveMigrationsDir,
} from './database/migration-runner';
import { assertAuthEnvSafe } from './modules/auth/auth-env';

async function bootstrap(): Promise<void> {
  // Fail-closed TRƯỚC mọi thứ khác (AC 9): AUTH_DEV_MODE sai môi trường → không khởi động
  assertAuthEnvSafe(process.env);

  // Migration chạy tự động, có thứ tự, trước khi nhận request (AC 4)
  const migrationPool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  try {
    await runMigrations(migrationPool, resolveMigrationsDir());
  } finally {
    await migrationPool.end();
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

bootstrap().catch((error: Error) => {
  console.error(`[FATAL] Khởi động thất bại: ${error.message}`);
  process.exit(1);
});
