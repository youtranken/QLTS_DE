import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { GlobalExceptionFilter } from './common/global-exception.filter';

/**
 * Cấu hình app dùng chung cho main.ts VÀ test e2e (test-app.helper) —
 * một nguồn duy nhất, e2e không được trôi khỏi production.
 * LƯU Ý: option `rawBody: true` phải đặt lúc TẠO app (main + helper) — webhook cần raw body.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  return app;
}
