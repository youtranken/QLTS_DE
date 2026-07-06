import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { Pool } from 'pg';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import {
  runMigrations,
  resolveMigrationsDir,
} from './database/migration-runner';
import { assertAuthEnvSafe } from './modules/auth/auth-env';

function requiredPort(): number {
  const raw = process.env.PORT ?? '3000';
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT không hợp lệ: ${JSON.stringify(raw)}`);
  }
  return port;
}

async function bootstrap(): Promise<void> {
  // Fail-closed TRƯỚC mọi thứ khác (AC 9): AUTH_DEV_MODE sai môi trường → không khởi động
  assertAuthEnvSafe(process.env);
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'Thiếu DATABASE_URL — không khởi động (tránh pg fallback localhost mù mờ).',
    );
  }
  const port = requiredPort();

  // Migration chạy tự động, có thứ tự, trước khi nhận request (AC 4)
  const migrationPool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  migrationPool.on('error', (error) => {
    console.error('[migration-pool] lỗi kết nối idle:', error);
  });
  try {
    await runMigrations(migrationPool, resolveMigrationsDir());
  } finally {
    await migrationPool.end();
  }

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true, // webhook PMH ID verify HMAC trên raw body
  });
  app.useLogger(app.get(Logger));
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((error: Error) => {
  // In đầy đủ stack + cause — lỗi khởi động trong container là chỗ hay hỏng nhất

  console.error('[FATAL] Khởi động thất bại:', error);
  process.exit(1);
});
