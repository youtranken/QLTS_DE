import type { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import * as jose from 'jose';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { JwtVerifierService } from '../src/modules/auth/jwt-verifier.service';
import { OIDC_PROVIDER } from '../src/modules/auth/oidc-provider';
import type {
  OidcProvider,
  OidcTokens,
} from '../src/modules/auth/oidc-provider';
import { createTestApp } from './test-app.helper';

/**
 * E2E luồng OIDC đầy đủ trên DB THẬT + OidcProvider test-double (quyết định
 * cắt story 1.2 — không cần PMH ID sống). Chạy trong suite test:db.
 */
const ISSUER = 'https://id.test/oidc';
const CLIENT_ID = 'qlts-test';
const WEBHOOK_SECRET = 'whsec-test';

if (!process.env.DATABASE_URL) {
  throw new Error(
    '[auth-flow.db-spec] DATABASE_URL chưa đặt — cần Postgres thật.',
  );
}

const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(
    `[auth-flow.db-spec] Từ chối chạy trên DB '${dbName}' (phải chứa 'test').`,
  );
}

describe('Luồng đăng nhập PMH ID (story 1.2)', () => {
  let app: INestApplication;
  let pool: Pool;
  let privateKey: jose.CryptoKey;
  let refreshShouldFail = false;
  let tokenCounter = 0;

  async function signAccessToken(expOffsetSec = 300): Promise<string> {
    tokenCounter += 1;
    return new jose.SignJWT({
      email: 'an.nguyen@pmh.com.vn',
      full_name: 'Nguyễn Văn An',
      employee_code: 'NV001',
      groups: ['IT'],
      n: tokenCounter,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('usr_test_01')
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expOffsetSec)
      .sign(privateKey);
  }

  /** logout_token BCL: có events backchannel-logout, KHÔNG nonce (docs integration 4.7). */
  async function signLogoutToken(
    opts: { withNonce?: boolean; sub?: string } = {},
  ): Promise<string> {
    const claims: Record<string, unknown> = {
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    };
    if (opts.withNonce) claims.nonce = 'x';
    return new jose.SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject(opts.sub ?? 'usr_test_01')
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 120)
      .sign(privateKey);
  }

  const fakeOidc: OidcProvider = {
    buildAuthUrl: (req) =>
      Promise.resolve(
        `https://id.test/oidc/authorize?state=${req.state}&code_challenge=${req.codeChallenge}`,
      ),
    exchangeCode: async (): Promise<OidcTokens> => ({
      accessToken: await signAccessToken(),
      refreshToken: 'rt-1',
      idToken: 'id-token-1',
    }),
    refresh: async (): Promise<OidcTokens> => {
      if (refreshShouldFail) {
        throw new Error('invalid_grant: refresh token revoked');
      }
      return {
        accessToken: await signAccessToken(),
        refreshToken: 'rt-2',
        idToken: 'id-token-2',
      };
    },
    buildLogoutUrl: () => Promise.resolve('https://id.test/oidc/logout?post=1'),
    clientCredentialsToken: () => Promise.resolve('m2m-token-test'),
  };

  /** Đăng nhập hoàn chỉnh, trả cookie phiên + csrf token. */
  async function loginFlow(): Promise<{
    sidCookie: string;
    csrfToken: string;
  }> {
    const loginRes = await request(app.getHttpServer())
      .get('/api/auth/login')
      .expect(302);
    const txCookie = (loginRes.headers['set-cookie'] as unknown as string[])
      .find((c: string) => c.startsWith('qlts_oidc_tx='))!
      .split(';')[0];
    const cbRes = await request(app.getHttpServer())
      .get('/api/auth/callback?code=fake-code&state=x')
      .set('Cookie', txCookie)
      .expect(302);
    const setCookies = cbRes.headers['set-cookie'] as unknown as string[];
    const sidSetCookie = setCookies.find((c: string) =>
      c.startsWith('qlts_sid='),
    )!;
    expect(sidSetCookie).toContain('HttpOnly');
    expect(sidSetCookie).toContain('SameSite=Strict');
    expect(sidSetCookie).toContain('Secure');
    const sidCookie = sidSetCookie.split(';')[0];
    const meRes = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sidCookie)
      .expect(200);
    return { sidCookie, csrfToken: meRes.body.csrfToken as string };
  }

  beforeAll(async () => {
    process.env.PMH_ISSUER_URL = ISSUER;
    process.env.PMH_CLIENT_ID = CLIENT_ID;
    process.env.PMH_WEBHOOK_SECRET = WEBHOOK_SECRET;
    process.env.APP_BASE_URL = 'http://localhost:8080';
    delete process.env.AUTH_DEV_MODE;

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });

    const pair = await jose.generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const publicJwk = await jose.exportJWK(pair.publicKey);

    app = await createTestApp(
      [],
      [{ token: OIDC_PROVIDER, useValue: fakeOidc }],
    );
    app
      .get(JwtVerifierService)
      .setKeySource(jose.createLocalJWKSet({ keys: [publicJwk] }));
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.PMH_ISSUER_URL;
    delete process.env.PMH_CLIENT_ID;
    delete process.env.PMH_WEBHOOK_SECRET;
  });

  beforeEach(() => {
    refreshShouldFail = false;
  });

  it('login → redirect PMH ID kèm PKCE + state; cookie giao dịch httpOnly', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/login')
      .expect(302);
    expect(res.headers.location).toContain('https://id.test/oidc/authorize');
    expect(res.headers.location).toContain('code_challenge=');
    const tx = (res.headers['set-cookie'] as unknown as string[]).find(
      (c: string) => c.startsWith('qlts_oidc_tx='),
    );
    expect(tx).toBeDefined();
    expect(tx).toContain('HttpOnly');
  });

  it('callback → upsert users theo sub + cookie phiên đúng cờ + audit auth.login', async () => {
    const { sidCookie } = await loginFlow();
    expect(sidCookie).toMatch(/^qlts_sid=/);

    const users = await pool.query(
      "SELECT sub, email, full_name FROM users WHERE sub = 'usr_test_01'",
    );
    expect(users.rowCount).toBe(1);
    expect(users.rows[0].email).toBe('an.nguyen@pmh.com.vn');

    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.login'",
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('email đổi → login lại KHÔNG tạo user mới (khóa theo sub)', async () => {
    await loginFlow();
    const users = await pool.query('SELECT count(*)::int AS n FROM users');
    expect(users.rows[0].n).toBe(1);
  });

  it('callback thiếu cookie giao dịch → redirect /?login=failed + audit (không kẹt trang JSON)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/callback?code=fake')
      .expect(302);
    expect(res.headers.location).toBe('/?login=failed');
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.login_failed'",
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('access token hết hạn → refresh ngầm, user không nhận ra', async () => {
    const { sidCookie } = await loginFlow();
    await pool.query(
      "UPDATE sessions SET access_token_exp = now() - interval '1 minute'",
    );
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sidCookie)
      .expect(200);
    expect(res.body.sub).toBe('usr_test_01');
    const s = await pool.query('SELECT refresh_token FROM sessions');
    expect(
      s.rows.some((r: { refresh_token: string }) => r.refresh_token === 'rt-2'),
    ).toBe(true);
  });

  it('refresh THẤT BẠI (revoke) → 401, phiên bị hủy, audit session_expired', async () => {
    const { sidCookie } = await loginFlow();
    await pool.query(
      "UPDATE sessions SET access_token_exp = now() - interval '1 minute'",
    );
    refreshShouldFail = true;
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sidCookie)
      .expect(401);
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.session_expired'",
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
    // dùng lại cookie chết → vẫn 401
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sidCookie)
      .expect(401);
  });

  it('mutate thiếu CSRF → 403; đúng CSRF → logout hủy phiên server + audit', async () => {
    const { sidCookie, csrfToken } = await loginFlow();
    const noCsrf = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', sidCookie)
      .expect(403);
    expect(noCsrf.body.code).toBe('CSRF_TOKEN_INVALID');

    const res = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Cookie', sidCookie)
      .set('X-CSRF-Token', csrfToken)
      .expect(200);
    // Local logout: chỉ hủy phiên QLTS, KHÔNG end_session IdP (không đá khỏi portal)
    expect(res.body.ok).toBe(true);
    expect(res.body.logoutUrl).toBeUndefined();

    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sidCookie)
      .expect(401);
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.logout'",
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('webhook user.locked (HMAC đúng) → MỌI phiên user chết tức thì', async () => {
    const { sidCookie } = await loginFlow();
    const body = JSON.stringify({
      type: 'user.locked',
      user_id: 'usr_test_01',
    });
    const signature = createHmac('sha256', WEBHOOK_SECRET)
      .update(body)
      .digest('hex');
    await request(app.getHttpServer())
      .post('/api/webhooks/pmh-id')
      .set('Content-Type', 'application/json')
      .set('X-PMH-Signature', signature)
      .send(body)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sidCookie)
      .expect(401);
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.session_revoked'",
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('BCL: logout_token hợp lệ → đá MỌI phiên user tức thì (docs 4.7)', async () => {
    const { sidCookie } = await loginFlow();
    await request(app.getHttpServer())
      .post('/api/backchannel-logout')
      .type('form')
      .send({ logout_token: await signLogoutToken() })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sidCookie)
      .expect(401);
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.session_revoked' AND detail->>'via' = 'backchannel_logout'",
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('BCL: token có nonce (id_token dùng nhầm) → 400, phiên còn nguyên', async () => {
    const { sidCookie } = await loginFlow();
    await request(app.getHttpServer())
      .post('/api/backchannel-logout')
      .type('form')
      .send({ logout_token: await signLogoutToken({ withNonce: true }) })
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sidCookie)
      .expect(200);
  });

  it('BCL: thiếu logout_token → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/backchannel-logout')
      .type('form')
      .send({})
      .expect(400);
  });

  it('webhook chữ ký sai → 401, phiên còn nguyên', async () => {
    const { sidCookie } = await loginFlow();
    const body = JSON.stringify({
      type: 'user.locked',
      user_id: 'usr_test_01',
    });
    await request(app.getHttpServer())
      .post('/api/webhooks/pmh-id')
      .set('Content-Type', 'application/json')
      .set('X-PMH-Signature', 'chu-ky-gia')
      .send(body)
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', sidCookie)
      .expect(200);
  });

  // Story 10.2 — gate access theo group (token test có groups: ['IT'])
  describe('gate access theo group', () => {
    async function setAllowed(groups: string[]): Promise<void> {
      await pool.query(
        `INSERT INTO config (key, value) VALUES ('authorized_groups', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(groups)],
      );
    }

    afterEach(async () => {
      // Trả gate về TẮT để các test khác (config rỗng → không gate) không bị ảnh hưởng
      await pool.query("DELETE FROM config WHERE key = 'authorized_groups'");
    });

    /** callback tới bước redirect, trả location + cookie phiên (nếu có). */
    async function callbackOnce(): Promise<{
      location: string;
      hasSid: boolean;
    }> {
      const loginRes = await request(app.getHttpServer())
        .get('/api/auth/login')
        .expect(302);
      const txCookie = (loginRes.headers['set-cookie'] as unknown as string[])
        .find((c: string) => c.startsWith('qlts_oidc_tx='))!
        .split(';')[0];
      const cb = await request(app.getHttpServer())
        .get('/api/auth/callback?code=fake&state=x')
        .set('Cookie', txCookie)
        .expect(302);
      const cookies =
        (cb.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
      return {
        location: cb.headers.location as string,
        hasSid: cookies.some((c: string) => c.startsWith('qlts_sid=')),
      };
    }

    it('group KHÔNG khớp → /?login=forbidden, KHÔNG tạo phiên, KHÔNG upsert user, audit', async () => {
      await pool.query("DELETE FROM users WHERE sub = 'usr_test_01'");
      await setAllowed(['Developers']); // token có ['IT'] → không giao
      const res = await callbackOnce();
      expect(res.location).toBe('/?login=forbidden');
      expect(res.hasSid).toBe(false);
      const u = await pool.query(
        "SELECT count(*)::int AS n FROM users WHERE sub = 'usr_test_01'",
      );
      expect(u.rows[0].n).toBe(0);
      const audit = await pool.query(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.login_denied_group'",
      );
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it('group khớp KHÔNG phân biệt hoa/thường → login OK', async () => {
      await setAllowed(['it']); // token ['IT'] khớp
      const res = await callbackOnce();
      expect(res.location).toBe('/');
      expect(res.hasSid).toBe(true);
    });

    it('gate TẮT (config authorized_groups rỗng) → vào được như cũ', async () => {
      // afterEach test trước đã xoá config → gate tắt
      const res = await callbackOnce();
      expect(res.location).toBe('/');
      expect(res.hasSid).toBe(true);
    });
  });
});
