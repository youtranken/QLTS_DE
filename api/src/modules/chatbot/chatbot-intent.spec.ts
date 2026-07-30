import { detectIntent } from './chatbot-intent';

/** Unit: router ý định (không LLM) — khớp đúng tool + bắt ngày/mã máy. */
describe('detectIntent', () => {
  const today = '2026-07-30';
  const intentOf = (msg: string) => detectIntent(msg, today)?.intent ?? null;

  it('máy trống + ngày mai → day_availability với ngày +1', () => {
    const r = detectIntent('có máy nào trống ngày mai không', today);
    expect(r).toEqual({
      intent: 'day_availability',
      params: { date: '2026-07-31' },
    });
  });

  it('máy trống không ngày → day_availability hôm nay', () => {
    expect(detectIntent('còn máy nào rảnh không', today)).toEqual({
      intent: 'day_availability',
      params: { date: today },
    });
  });

  it('bắt ngày d/m → năm hiện tại', () => {
    expect(detectIntent('máy trống ngày 3/8', today)?.params).toEqual({
      date: '2026-08-03',
    });
  });

  it('cấu hình + mã → get_asset', () => {
    expect(detectIntent('cấu hình MTS-123 thế nào', today)).toEqual({
      intent: 'get_asset',
      params: { code: 'MTS-123' },
    });
  });

  it('gõ gần như chỉ mã → get_asset', () => {
    expect(detectIntent('3-AA-CT-1444', today)).toEqual({
      intent: 'get_asset',
      params: { code: '3-AA-CT-1444' },
    });
  });

  it('lịch sử + mã → asset_history', () => {
    expect(detectIntent('ai từng dùng máy MTS-123', today)).toEqual({
      intent: 'asset_history',
      params: { code: 'MTS-123' },
    });
  });

  it('của tôi / đang mượn', () => {
    expect(intentOf('tài sản của tôi')).toBe('my_assets');
    expect(intentOf('tôi đang mượn gì')).toBe('my_borrowings');
  });

  it('admin intents', () => {
    expect(intentOf('có gì chờ duyệt không')).toBe('pending_approvals');
    expect(intentOf('máy nào sắp hết hạn')).toBe('eol_alerts');
    expect(intentOf('thống kê phần mềm')).toBe('software_info');
    expect(intentOf('công ty có bao nhiêu máy')).toBe('asset_stats');
  });

  it('không khớp luật → null (lùi về tìm từ khoá)', () => {
    expect(detectIntent('dell latitude', today)).toBeNull();
    expect(detectIntent('', today)).toBeNull();
  });

  it('"bao nhiêu máy trống" ưu tiên availability (không phải stats)', () => {
    expect(intentOf('bao nhiêu máy còn trống')).toBe('day_availability');
  });

  it('máy CỤ THỂ có trống ngày X → day_availability kèm code', () => {
    expect(detectIntent('MTS-123 có trống ngày mai không', today)).toEqual({
      intent: 'day_availability',
      params: { date: '2026-07-31', code: 'MTS-123' },
    });
  });

  it('nhóm A: hạn trả / quá hạn / trạng thái → my_borrowings', () => {
    expect(intentOf('khi nào tôi phải trả máy')).toBe('my_borrowings');
    expect(intentOf('tôi có máy nào quá hạn không')).toBe('my_borrowings');
    expect(intentOf('yêu cầu mượn của tôi duyệt chưa')).toBe('my_borrowings');
  });

  it('máy đang sửa chữa → list_result lọc trạng thái', () => {
    expect(detectIntent('máy nào đang sửa chữa', today)).toEqual({
      intent: 'list_result',
      params: { status: 'locked_repair' },
    });
  });

  it('chính sách: giờ làm việc / thời hạn mượn', () => {
    expect(intentOf('mượn được từ mấy giờ')).toBe('policy_hours');
    expect(intentOf('mượn tối đa mấy ngày')).toBe('policy_borrow');
    expect(intentOf('cuối tuần có mượn được không')).toBe('policy_borrow');
  });

  it('trợ giúp', () => {
    expect(intentOf('bạn làm được gì')).toBe('help');
    expect(intentOf('hướng dẫn cho mình')).toBe('help');
  });
});
