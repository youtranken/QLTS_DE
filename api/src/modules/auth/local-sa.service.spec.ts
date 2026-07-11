import {
  hashPassword,
  verifyPassword,
  LocalSaService,
} from './local-sa.service';

describe('scrypt hash/verify (story 10.1)', () => {
  it('round-trip: verify đúng mật khẩu, sai mật khẩu false', () => {
    const stored = hashPassword('S3cr3t!pw');
    expect(stored).toMatch(/^scrypt\.[0-9a-f]+\.[0-9a-f]+$/);
    expect(verifyPassword('S3cr3t!pw', stored)).toBe(true);
    expect(verifyPassword('S3cr3t!px', stored)).toBe(false);
  });

  it('hash mỗi lần khác nhau (salt ngẫu nhiên) nhưng đều verify được', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a).not.toBe(b);
    expect(verifyPassword('same', a)).toBe(true);
    expect(verifyPassword('same', b)).toBe(true);
  });

  it('định dạng lưu sai → false (không ném)', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$abc')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$aa$bb')).toBe(false);
    expect(verifyPassword('x', 'scrypt$aa$')).toBe(false);
  });
});

describe('LocalSaService lockout (story 10.1)', () => {
  const USER = 'sa';
  const PASS = 'break-glass-pw';

  function makeService(): LocalSaService {
    process.env.LOCAL_SA_USERNAME = USER;
    process.env.LOCAL_SA_PASSWORD_HASH = hashPassword(PASS);
    return new LocalSaService();
  }

  afterEach(() => {
    delete process.env.LOCAL_SA_USERNAME;
    delete process.env.LOCAL_SA_PASSWORD_HASH;
    jest.useRealTimers();
  });

  it('đúng → ok; sai → bad; lần thứ 5 → locked; sau đó locked kể cả đúng', () => {
    const svc = makeService();
    const ip = '1.1.1.1';
    expect(svc.attemptLogin(USER, PASS, ip)).toBe('ok');
    for (let i = 0; i < 4; i += 1) {
      expect(svc.attemptLogin(USER, 'bad', ip)).toBe('bad');
    }
    expect(svc.attemptLogin(USER, 'bad', ip)).toBe('locked');
    expect(svc.attemptLogin(USER, PASS, ip)).toBe('locked');
  });

  it('IP khác không bị ảnh hưởng bởi lockout của IP kia', () => {
    const svc = makeService();
    for (let i = 0; i < 5; i += 1) svc.attemptLogin(USER, 'bad', '2.2.2.2');
    expect(svc.attemptLogin(USER, PASS, '2.2.2.2')).toBe('locked');
    expect(svc.attemptLogin(USER, PASS, '3.3.3.3')).toBe('ok');
  });

  it('đăng nhập đúng RESET bộ đếm sai của IP', () => {
    const svc = makeService();
    const ip = '4.4.4.4';
    svc.attemptLogin(USER, 'bad', ip);
    svc.attemptLogin(USER, 'bad', ip);
    expect(svc.attemptLogin(USER, PASS, ip)).toBe('ok');
    // đếm lại từ đầu: 4 lần sai kế tiếp vẫn 'bad' (chưa khoá)
    for (let i = 0; i < 4; i += 1) {
      expect(svc.attemptLogin(USER, 'bad', ip)).toBe('bad');
    }
  });

  it('hết 15 phút khoá → cho thử lại (lock hết hạn)', () => {
    jest.useFakeTimers();
    const svc = makeService();
    const ip = '5.5.5.5';
    for (let i = 0; i < 5; i += 1) svc.attemptLogin(USER, 'bad', ip);
    expect(svc.attemptLogin(USER, PASS, ip)).toBe('locked');
    jest.advanceTimersByTime(15 * 60 * 1000 + 1000);
    expect(svc.attemptLogin(USER, PASS, ip)).toBe('ok');
  });
});
