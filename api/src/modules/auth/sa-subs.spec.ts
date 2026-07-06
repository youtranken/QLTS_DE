import { assertSaSubsConfigured, parseSaSubs } from './sa-subs';

describe('SA_SUBS (story 1.5 — SA chỉ từ env, fail-closed)', () => {
  it('parse danh sách phẩy, trim khoảng trắng, bỏ phần tử rỗng', () => {
    expect([...parseSaSubs({ SA_SUBS: 'a, b ,,c' })]).toEqual(['a', 'b', 'c']);
  });

  it.each([
    [undefined, true],
    ['', true],
    ['  ', true],
    [',,,', true],
    ['sub-1', false],
    ['sub-1,sub-2', false],
  ])('SA_SUBS=%p → throw=%p', (value, shouldThrow) => {
    const env = { SA_SUBS: value };
    if (shouldThrow) {
      expect(() => assertSaSubsConfigured(env)).toThrow(/SA_SUBS/);
    } else {
      expect(() => assertSaSubsConfigured(env)).not.toThrow();
    }
  });
});
