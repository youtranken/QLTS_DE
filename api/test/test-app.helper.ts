import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

export interface ProviderOverride {
  token: unknown;
  useValue: unknown;
}

/** Dựng app e2e đúng cấu hình production — dùng chung configureApp với main.ts. */
export async function createTestApp(
  extraControllers: Array<new (...args: never[]) => unknown> = [],
  overrides: ProviderOverride[] = [],
): Promise<INestApplication> {
  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  });
  for (const o of overrides) {
    builder = builder.overrideProvider(o.token).useValue(o.useValue);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app);
  await app.init();
  return app;
}
