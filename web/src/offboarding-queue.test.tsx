import { describe, it, expect, vi } from 'vitest';
import { OffboardingQueuePage } from '@/offboarding-queue';
import {
  jsonResponse,
  renderWithI18n,
  screen,
  userEvent,
  waitFor,
} from '@/test/test-utils';

const LOAD_ERROR = 'Không tải được dữ liệu — thử lại.';
const OK_BODY = { total: 0, alerts: [], needsMatch: [] };

describe('OffboardingQueuePage — hợp đồng loading/error (P0)', () => {
  it('fetch lỗi → hiện LoadError, KHÔNG kẹt "…" im lặng', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})));
    renderWithI18n(<OffboardingQueuePage />);
    expect(await screen.findByText(LOAD_ERROR)).toBeInTheDocument();
  });

  it('bấm Thử lại → refetch, thành công thì hết lỗi', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
    vi.stubGlobal('fetch', fetchMock);
    renderWithI18n(<OffboardingQueuePage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Thử lại' }));

    await waitFor(() =>
      expect(screen.queryByText(LOAD_ERROR)).not.toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
