import { describe, it, expect, vi } from 'vitest';
import { BorrowBoardPage } from './borrow-board';
import type { Me } from './panels';
import {
  jsonResponse,
  renderWithI18n,
  screen,
  within,
  waitFor,
  userEvent,
} from './test/test-utils';

const ME = { sub: 'm', role: 'member', csrfToken: null } as unknown as Me;

// PC-99 quá hạn đứng đầu (server sort overdue-first); PC-01 sau.
const ROWS = [
  { ticketId: 't2', assetCode: 'PC-99', type: 'desktop', borrowerName: 'Binh', from: '2026-07-09T01:00:00Z', due: '2026-07-09T02:00:00Z', state: 'in_use', isOverdue: true, isMine: false, note: null, recurringCount: null },
  { ticketId: 't1', assetCode: 'PC-01', type: 'laptop', borrowerName: 'An', from: '2026-07-10T01:00:00Z', due: '2026-07-12T01:00:00Z', state: 'in_use', isOverdue: false, isMine: false, note: 'ghi chu', recurringCount: null },
];

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      typeof url === 'string' && url.startsWith('/api/booking/board')
        ? Promise.resolve(jsonResponse(200, ROWS))
        : Promise.resolve(jsonResponse(200, [])),
    ),
  );
}

function codes(): (string | null)[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getByText(/PC-/).textContent);
}

describe('BorrowBoardPage — dùng DataTable', () => {
  it('dòng quá hạn có class row-overdue', async () => {
    stub();
    renderWithI18n(<BorrowBoardPage me={ME} />);
    await screen.findByText('PC-99');
    expect(screen.getByText('PC-99').closest('tr')).toHaveClass('row-overdue');
    expect(screen.getByText('PC-01').closest('tr')).not.toHaveClass('row-overdue');
  });

  it('bấm header "Thiết bị" sắp xếp tăng dần theo mã', async () => {
    stub();
    renderWithI18n(<BorrowBoardPage me={ME} />);
    await screen.findByText('PC-99');
    expect(codes()).toEqual(['PC-99', 'PC-01']); // mặc định overdue-first
    await userEvent.click(screen.getByRole('button', { name: /Thiết bị/ }));
    expect(codes()).toEqual(['PC-01', 'PC-99']);
  });

  it('ô lọc thu hẹp theo mã máy', async () => {
    stub();
    renderWithI18n(<BorrowBoardPage me={ME} />);
    await screen.findByText('PC-99');
    await userEvent.type(
      screen.getByLabelText('Lọc theo máy / người mượn / ghi chú…'),
      'PC-01',
    );
    await waitFor(() =>
      expect(screen.queryByText('PC-99')).not.toBeInTheDocument(),
    );
    expect(codes()).toEqual(['PC-01']);
  });
});
