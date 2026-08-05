import { intersectsCI } from './group-access';

describe('intersectsCI (gate access theo group, story 10.2)', () => {
  it('có group giao → true', () => {
    expect(intersectsCI(['Developers', 'Kế toán'], ['Developers'])).toBe(true);
  });

  it('không giao → false', () => {
    expect(intersectsCI(['Kế toán'], ['Developers'])).toBe(false);
  });

  it('không phân biệt hoa/thường', () => {
    expect(intersectsCI(['developers'], ['Developers'])).toBe(true);
    expect(intersectsCI(['DEVELOPERS'], ['developers'])).toBe(true);
  });

  it('user không có group / rỗng → false (fail-closed khi gate bật)', () => {
    expect(intersectsCI([], ['Developers'])).toBe(false);
    expect(intersectsCI(undefined, ['Developers'])).toBe(false);
  });

  it('allowed rỗng → false (caller phải tự bỏ qua gate khi allowed rỗng)', () => {
    expect(intersectsCI(['Developers'], [])).toBe(false);
  });

  it('phần tử không phải string trong groups → bỏ qua an toàn', () => {
    expect(
      intersectsCI(['Developers', null as unknown as string], ['Developers']),
    ).toBe(true);
  });
});
