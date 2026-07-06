import { INestApplication, ValidationPipe } from '@nestjs/common';
import { GlobalExceptionFilter } from './common/global-exception.filter';

/**
 * Cấu hình app dùng chung cho main.ts VÀ test e2e (test-app.helper) —
 * một nguồn duy nhất, e2e không được trôi khỏi production.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());
  return app;
}
