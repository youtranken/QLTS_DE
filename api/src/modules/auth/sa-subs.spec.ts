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
    ['sub-a;sub-b', true], // nhầm ; thành , → 1 entry chứa ; → sai định dạng
    ['sub a,sub-b12', true], // entry chứa khoảng trắng
    ['ngắn', true], // entry < 8 ký tự
    ['0e21b0f0-ae8e-4670-bdf6-dfd7b78092d7', false],
    ['sub-0001,sub-0002', false],
  ])('SA_SUBS=%p → throw=%p', (value, shouldThrow) => {
    const env = { SA_SUBS: value };
    if (shouldThrow) {
      expect(() => assertSaSubsConfigured(env)).toThrow(/SA_SUBS/);
    } else {
      expect(() => assertSaSubsConfigured(env)).not.toThrow();
    }
  });
});
