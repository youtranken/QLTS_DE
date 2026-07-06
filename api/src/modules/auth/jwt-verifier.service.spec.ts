import * as jose from 'jose';
import { JwtVerifierService } from './jwt-verifier.service';

const ISSUER = 'https://id.test/oidc';
const CLIENT_ID = 'qlts-test';

describe('JwtVerifierService — verify offline RS256 (AC 3)', () => {
  let verifier: JwtVerifierService;
  let privateKey: jose.CryptoKey;

  async function sign(
    overrides: Record<string, unknown> = {},
    opts: { iss?: string; aud?: string; expOffsetSec?: number } = {},
  ): Promise<string> {
    return new jose.SignJWT({
      email: 'an.nguyen@pmh.com.vn',
      full_name: 'Nguyễn Văn An',
      employee_code: 'NV001',
      groups: ['IT'],
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('usr_test_01')
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(
        Math.floor(Date.now() / 1000) + (opts.expOffsetSec ?? 300),
      )
      .sign(privateKey);
  }

  beforeAll(async () => {
    process.env.PMH_ISSUER_URL = ISSUER;
    process.env.PMH_CLIENT_ID = CLIENT_ID;
    const pair = await jose.generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const publicJwk = await jose.exportJWK(pair.publicKey);
    verifier = new JwtVerifierService();
    verifier.setKeySource(jose.createLocalJWKSet({ keys: [publicJwk] }));
  });

  afterAll(() => {
    delete process.env.PMH_ISSUER_URL;
    delete process.env.PMH_CLIENT_ID;
  });

  it('token hợp lệ → claims + expiresAt từ exp', async () => {
    const token = await sign();
    const result = await verifier.verify(token);
    expect(result.claims).toEqual({
      sub: 'usr_test_01',
      email: 'an.nguyen@pmh.com.vn',
      full_name: 'Nguyễn Văn An',
      employee_code: 'NV001',
      groups: ['IT'],
    });
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('sai audience → fail', async () => {
    const token = await sign({}, { aud: 'app-khac' });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('sai issuer → fail', async () => {
    const token = await sign({}, { iss: 'https://id-gia-mao.test/oidc' });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('hết hạn quá clockTolerance (−120s) → fail', async () => {
    const token = await sign({}, { expOffsetSec: -120 });
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('hết hạn trong clockTolerance ±60s (−30s) → vẫn pass (chống 401 chập chờn)', async () => {
    const token = await sign({}, { expOffsetSec: -30 });
    await expect(verifier.verify(token)).resolves.toBeDefined();
  });

  it('token ký bằng khóa khác → fail', async () => {
    const otherPair = await jose.generateKeyPair('RS256');
    const forged = await new jose.SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('usr_test_01')
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setExpirationTime('5m')
      .sign(otherPair.privateKey);
    await expect(verifier.verify(forged)).rejects.toThrow();
  });
});
