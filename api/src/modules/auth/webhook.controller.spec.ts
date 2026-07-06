import { UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { WebhookController } from './webhook.controller';

const SECRET = 'whsec-test';

function makeController() {
  const sessions = { destroyAllForUser: jest.fn().mockResolvedValue(2) };
  const users = { updateGroups: jest.fn().mockResolvedValue(undefined) };
  const audit = { append: jest.fn().mockResolvedValue(undefined) };
  const controller = new WebhookController(
    sessions as never,
    users as never,
    audit as never,
  );
  return { controller, sessions, users, audit };
}

function signedReq(body: object, secret = SECRET) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return { rawBody, signature };
}

describe('WebhookController — HMAC + đá phiên (AC 6)', () => {
  beforeAll(() => {
    process.env.PMH_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    delete process.env.PMH_WEBHOOK_SECRET;
  });

  it('chữ ký đúng + user.locked → hủy mọi phiên user + audit actor=system', async () => {
    const { controller, sessions, audit } = makeController();
    const { rawBody, signature } = signedReq({
      type: 'user.locked',
      user_id: 'usr_1',
    });
    const result = await controller.handle({ rawBody } as never, signature);
    expect(result).toEqual({ ok: true });
    expect(sessions.destroyAllForUser).toHaveBeenCalledWith('usr_1');
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'system',
        action: 'auth.session_revoked',
      }),
    );
  });

  it('user.groups_changed → cập nhật groups, không đá phiên', async () => {
    const { controller, sessions, users } = makeController();
    const { rawBody, signature } = signedReq({
      type: 'user.groups_changed',
      user_id: 'usr_1',
      groups: ['Kế toán'],
    });
    await controller.handle({ rawBody } as never, signature);
    expect(users.updateGroups).toHaveBeenCalledWith('usr_1', ['Kế toán']);
    expect(sessions.destroyAllForUser).not.toHaveBeenCalled();
  });

  it('sai chữ ký → 401, KHÔNG xử lý, audit webhook_rejected', async () => {
    const { controller, sessions, audit } = makeController();
    const { rawBody } = signedReq({ type: 'user.locked', user_id: 'usr_1' });
    const bad = createHmac('sha256', 'secret-khac')
      .update(rawBody)
      .digest('hex');
    await expect(controller.handle({ rawBody } as never, bad)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(sessions.destroyAllForUser).not.toHaveBeenCalled();
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.webhook_rejected' }),
    );
  });

  it('chữ ký khác ĐỘ DÀI → 401 sạch, không crash (timingSafeEqual edge)', async () => {
    const { controller } = makeController();
    const { rawBody } = signedReq({ type: 'user.locked', user_id: 'usr_1' });
    await expect(
      controller.handle({ rawBody } as never, 'ngắn'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('thiếu chữ ký / thiếu rawBody → 401', async () => {
    const { controller } = makeController();
    const { rawBody } = signedReq({ type: 'user.locked', user_id: 'usr_1' });
    await expect(
      controller.handle({ rawBody } as never, undefined),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      controller.handle({ rawBody: undefined } as never, 'sig'),
    ).rejects.toThrow(UnauthorizedException);
  });
});
