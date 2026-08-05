import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';

function makeContext(params: {
  method: string;
  isPublic?: boolean;
  sessionId?: string;
  csrfHeader?: string;
}) {
  const request = {
    method: params.method,
    headers: params.csrfHeader ? { 'x-csrf-token': params.csrfHeader } : {},
    user: params.sessionId
      ? {
          sub: 'usr_1',
          role: 'member',
          devMode: false,
          sessionId: params.sessionId,
        }
      : undefined,
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(params.isPublic ?? false),
  };
  return { context, reflector };
}

describe('CsrfGuard (AC 2)', () => {
  const sessions = {
    find: jest.fn(),
  };

  function guard(reflector: unknown): CsrfGuard {
    return new CsrfGuard(reflector as never, sessions as never);
  }

  beforeEach(() => jest.clearAllMocks());

  it('GET → bỏ qua', async () => {
    const { context, reflector } = makeContext({ method: 'GET' });
    await expect(guard(reflector).canActivate(context)).resolves.toBe(true);
  });

  it('POST route @Public (webhook — HMAC riêng) → bỏ qua', async () => {
    const { context, reflector } = makeContext({
      method: 'POST',
      isPublic: true,
    });
    await expect(guard(reflector).canActivate(context)).resolves.toBe(true);
  });

  it('POST identity dev-header (không session cookie) → bỏ qua (không có CSRF risk)', async () => {
    const { context, reflector } = makeContext({ method: 'POST' });
    await expect(guard(reflector).canActivate(context)).resolves.toBe(true);
  });

  it('POST phiên cookie + token đúng → pass', async () => {
    sessions.find.mockResolvedValue({ csrfToken: 'tok-123' });
    const { context, reflector } = makeContext({
      method: 'POST',
      sessionId: 'sid-1',
      csrfHeader: 'tok-123',
    });
    await expect(guard(reflector).canActivate(context)).resolves.toBe(true);
  });

  it('POST phiên cookie + token sai → 403 CSRF_TOKEN_INVALID', async () => {
    sessions.find.mockResolvedValue({ csrfToken: 'tok-123' });
    const { context, reflector } = makeContext({
      method: 'POST',
      sessionId: 'sid-1',
      csrfHeader: 'tok-gia',
    });
    await expect(guard(reflector).canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('DELETE phiên cookie + THIẾU token → 403', async () => {
    const { context, reflector } = makeContext({
      method: 'DELETE',
      sessionId: 'sid-1',
    });
    await expect(guard(reflector).canActivate(context)).rejects.toThrow(
      ForbiddenException,
    );
  });
});
