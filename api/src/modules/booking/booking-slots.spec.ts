import { computeFreeSlots } from './booking.service';

/** Unit: tính khung giờ trống = giờ làm − block bận (thuần, không DB). */
describe('computeFreeSlots', () => {
  const ws = Date.parse('2026-07-27T07:00:00+07:00');
  const we = Date.parse('2026-07-27T18:00:00+07:00');
  const at = (h: string) => Date.parse(`2026-07-27T${h}:00+07:00`);

  it('không bận → trống cả ngày làm', () => {
    expect(computeFreeSlots(ws, we, [])).toEqual([
      { from: '07:00', to: '18:00' },
    ]);
  });

  it('bận giữa ngày → 2 khe trống', () => {
    const busy = [
      { from: '2026-07-27T09:00:00+07:00', to: '2026-07-27T10:00:00+07:00' },
    ];
    expect(computeFreeSlots(ws, we, busy)).toEqual([
      { from: '07:00', to: '09:00' },
      { from: '10:00', to: '18:00' },
    ]);
  });

  it('bận trùm cả giờ làm → không còn khe', () => {
    const busy = [
      { from: '2026-07-27T06:00:00+07:00', to: '2026-07-27T19:00:00+07:00' },
    ];
    expect(computeFreeSlots(ws, we, busy)).toEqual([]);
  });

  it('nhiều block chồng/nối → gộp đúng', () => {
    const busy = [
      { from: '2026-07-27T08:00:00+07:00', to: '2026-07-27T11:00:00+07:00' },
      { from: '2026-07-27T10:00:00+07:00', to: '2026-07-27T12:00:00+07:00' },
      { from: '2026-07-27T15:00:00+07:00', to: '2026-07-27T16:00:00+07:00' },
    ];
    expect(computeFreeSlots(ws, we, busy)).toEqual([
      { from: '07:00', to: '08:00' },
      { from: '12:00', to: '15:00' },
      { from: '16:00', to: '18:00' },
    ]);
  });

  it('block vượt biên → kẹp về giờ làm', () => {
    const busy = [
      { from: '2026-07-27T05:00:00+07:00', to: '2026-07-27T08:30:00+07:00' },
    ];
    expect(computeFreeSlots(ws, we, busy)).toEqual([
      { from: '08:30', to: '18:00' },
    ]);
    // sanity: at() dùng để tránh cảnh báo unused
    expect(at('07:00')).toBe(ws);
  });
});
