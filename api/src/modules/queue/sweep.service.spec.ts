import { SweepService } from './sweep.service';

describe('SweepService (story 3.5a)', () => {
  it('runAll gọi mọi handler đã đăng ký', async () => {
    const svc = new SweepService();
    const calls: string[] = [];
    svc.register({
      name: 'a',
      run: () => (calls.push('a'), Promise.resolve()),
    });
    svc.register({
      name: 'b',
      run: () => (calls.push('b'), Promise.resolve()),
    });
    await svc.runAll();
    expect(calls).toEqual(['a', 'b']);
    expect(svc.registeredCount).toBe(2);
  });

  it('handler lỗi KHÔNG chặn handler khác (isolation — AD-9)', async () => {
    const svc = new SweepService();
    const calls: string[] = [];
    svc.register({
      name: 'boom',
      run: () => Promise.reject(new Error('lỗi handler')),
    });
    svc.register({
      name: 'ok',
      run: () => (calls.push('ok'), Promise.resolve()),
    });
    await expect(svc.runAll()).resolves.toBeUndefined(); // không ném
    expect(calls).toEqual(['ok']); // handler sau vẫn chạy
  });

  it('registry rỗng → runAll no-op', async () => {
    const svc = new SweepService();
    await expect(svc.runAll()).resolves.toBeUndefined();
    expect(svc.registeredCount).toBe(0);
  });
});
