import { assertAuthEnvSafe, isDevAuthActive } from './auth-env';

describe('assertAuthEnvSafe (AC 9 — fail-closed)', () => {
  const cases: Array<{
    nodeEnv: string | undefined;
    flag: string | undefined;
    shouldThrow: boolean;
  }> = [
    { nodeEnv: 'development', flag: 'true', shouldThrow: false },
    { nodeEnv: 'test', flag: 'true', shouldThrow: false },
    { nodeEnv: 'production', flag: 'true', shouldThrow: true },
    { nodeEnv: 'staging', flag: 'true', shouldThrow: true },
    { nodeEnv: undefined, flag: 'true', shouldThrow: true },
    { nodeEnv: '', flag: 'true', shouldThrow: true },
    { nodeEnv: 'production', flag: 'false', shouldThrow: false },
    { nodeEnv: 'production', flag: undefined, shouldThrow: false },
    { nodeEnv: undefined, flag: undefined, shouldThrow: false },
  ];

  it.each(cases)(
    'NODE_ENV=$nodeEnv + AUTH_DEV_MODE=$flag → throw=$shouldThrow',
    ({ nodeEnv, flag, shouldThrow }) => {
      const env = { NODE_ENV: nodeEnv, AUTH_DEV_MODE: flag };
      if (shouldThrow) {
        expect(() => assertAuthEnvSafe(env)).toThrow(/AUTH_DEV_MODE/);
      } else {
        expect(() => assertAuthEnvSafe(env)).not.toThrow();
      }
    },
  );
});

describe('isDevAuthActive (allowlist tường minh)', () => {
  it('chỉ active với development/test + flag true', () => {
    expect(
      isDevAuthActive({ NODE_ENV: 'development', AUTH_DEV_MODE: 'true' }),
    ).toBe(true);
    expect(isDevAuthActive({ NODE_ENV: 'test', AUTH_DEV_MODE: 'true' })).toBe(
      true,
    );
  });

  it('không active khi flag tắt hoặc môi trường ngoài allowlist', () => {
    expect(isDevAuthActive({ NODE_ENV: 'test', AUTH_DEV_MODE: 'false' })).toBe(
      false,
    );
    expect(
      isDevAuthActive({ NODE_ENV: 'test', AUTH_DEV_MODE: undefined }),
    ).toBe(false);
    expect(
      isDevAuthActive({ NODE_ENV: 'production', AUTH_DEV_MODE: 'true' }),
    ).toBe(false);
    expect(
      isDevAuthActive({ NODE_ENV: 'staging', AUTH_DEV_MODE: 'true' }),
    ).toBe(false);
    expect(
      isDevAuthActive({ NODE_ENV: undefined, AUTH_DEV_MODE: 'true' }),
    ).toBe(false);
  });
});
