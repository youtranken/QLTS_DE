import { ServiceUnavailableException } from '@nestjs/common';
import { SessionAuthService } from './session-auth.service';
import type { SessionRecord } from './session.service';

function makeService(opts: {
  session?: Partial<SessionRecord> | null;
  refreshImpl?: jest.Mock;
  updateResult?: boolean;
}) {
  const session: SessionRecord | null =
    opts.session === null
      ? null
      : {
          id: 'sid-1',
          userSub: 'usr_1',
          refreshToken: 'rt-1',
          accessTokenExp: new Date(Date.now() - 60_000), // hết hạn
          claims: { sub: 'usr_1', full_name: 'Test', groups: [] },
          csrfToken: 'tok',
          ...opts.session,
        };
  const sessions = {
    find: jest.fn().mockResolvedValue(session),
    updateTokens: jest.fn().mockResolvedValue(opts.updateResult ?? true),
    destroy: jest.fn().mockResolvedValue(undefined),
  };
  const jwtVerifier = {
    verify: jest.fn().mockResolvedValue({
      claims: { sub: 'usr_1', full_name: 'Test', groups: [] },
      expiresAt: new Date(Date.now() + 300_000),
    }),
  };
  const oidc = {
    refresh:
      opts.refreshImpl ??
      jest
        .fn()
        .mockResolvedValue({ accessToken: 'jwt-moi', refreshToken: 'rt-2' }),
  };
  const audit = { append: jest.fn().mockResolvedValue(undefined) };
  const users = { findBySub: jest.fn().mockResolvedValue({ role: 'member' }) };
  const service = new SessionAuthService(
    sessions as never,
    jwtVerifier as never,
    oidc as never,
    audit as never,
    users as never,
  );
  return { service, sessions, oidc, audit, users };
}

describe('SessionAuthService — refresh ngầm (review fixes)', () => {
  it('single-flight: 3 request song song cùng phiên → refresh đúng MỘT lần', async () => {
    let resolveRefresh!: (v: unknown) => void;
    const refreshImpl = jest.fn().mockReturnValue(
      new Promise((r) => {
        resolveRefresh = r;
      }),
    );
    const { service, oidc } = makeService({ refreshImpl });
    const p = Promise.all([
      service.resolve('sid-1'),
      service.resolve('sid-1'),
      service.resolve('sid-1'),
    ]);
    // nhả refresh sau khi cả 3 đã vào
    resolveRefresh({ accessToken: 'jwt-moi', refreshToken: 'rt-2' });
    const results = await p;
    expect(oidc.refresh).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r?.sub === 'usr_1')).toBe(true);
  });

  it('refresh bị TỪ CHỐI (invalid_grant) → hủy phiên + audit session_expired', async () => {
    const err = Object.assign(new Error('grant fail'), {
      error: 'invalid_grant',
    });
    const { service, sessions, audit } = makeService({
      refreshImpl: jest.fn().mockRejectedValue(err),
    });
    const result = await service.resolve('sid-1');
    expect(result).toBeNull();
    expect(sessions.destroy).toHaveBeenCalledWith('sid-1');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.session_expired' }),
    );
  });

  it('PMH ID SẬP (lỗi mạng) → GIỮ phiên, ném 503 SSO_UNAVAILABLE — không logout oan', async () => {
    const { service, sessions } = makeService({
      refreshImpl: jest.fn().mockRejectedValue(new TypeError('fetch failed')),
    });
    await expect(service.resolve('sid-1')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(sessions.destroy).not.toHaveBeenCalled();
  });

  it('provider ném ServiceUnavailable (SSO chưa cấu hình) → rethrow, GIỮ phiên', async () => {
    const { service, sessions } = makeService({
      refreshImpl: jest.fn().mockRejectedValue(
        new ServiceUnavailableException({
          code: 'SSO_UNAVAILABLE',
          message: 'x',
        }),
      ),
    });
    await expect(service.resolve('sid-1')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(sessions.destroy).not.toHaveBeenCalled();
  });

  it('updateTokens trả false (webhook đá phiên giữa chừng) → null, không xác thực', async () => {
    const { service } = makeService({ updateResult: false });
    const result = await service.resolve('sid-1');
    expect(result).toBeNull();
  });

  it('token còn hạn → dùng claims trong session, KHÔNG gọi refresh', async () => {
    const { service, oidc } = makeService({
      session: { accessTokenExp: new Date(Date.now() + 60_000) },
    });
    const result = await service.resolve('sid-1');
    expect(result?.sub).toBe('usr_1');
    expect(oidc.refresh).not.toHaveBeenCalled();
  });
});
