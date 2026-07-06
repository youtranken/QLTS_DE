/**
 * Seam dev-identity (AUTH_DEV_MODE) — story 1.1, AC 9.
 * ALLOWLIST tường minh: seam chỉ được phép sống ở development/test.
 * Fail-closed: bật flag ở môi trường ngoài allowlist → app từ chối khởi động.
 */
const ALLOWED_ENVS = ['development', 'test'] as const;

export type EnvLike = Record<string, string | undefined>;

export function isDevAuthActive(env: EnvLike): boolean {
  return (
    env.AUTH_DEV_MODE === 'true' &&
    ALLOWED_ENVS.includes(env.NODE_ENV as (typeof ALLOWED_ENVS)[number])
  );
}

export function assertAuthEnvSafe(env: EnvLike): void {
  if (
    env.AUTH_DEV_MODE === 'true' &&
    !ALLOWED_ENVS.includes(env.NODE_ENV as (typeof ALLOWED_ENVS)[number])
  ) {
    throw new Error(
      `AUTH_DEV_MODE=true chỉ được phép khi NODE_ENV thuộc [${ALLOWED_ENVS.join(', ')}]; ` +
        `NODE_ENV hiện tại: ${JSON.stringify(env.NODE_ENV ?? null)}. Từ chối khởi động (fail-closed).`,
    );
  }
}
