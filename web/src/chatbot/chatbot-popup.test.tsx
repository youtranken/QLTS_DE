import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ChatbotPopup } from '@/chatbot/chatbot-popup';
import type { Me } from '@/lib/me';
import {
  jsonResponse,
  renderWithI18n,
  screen,
  userEvent,
} from '@/test/test-utils';

const ME = {
  sub: 'u1',
  role: 'member',
  fullName: 'Nguyễn Văn An',
  csrfToken: 'tok',
} as unknown as Me;

interface FetchCall {
  url: string;
  init?: { method?: string; body?: string };
}

function stub(reply: Record<string, unknown>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, init });
      if (url.includes('/api/chatbot/message')) {
        return Promise.resolve(jsonResponse(201, reply));
      }
      if (url.includes('/api/chatbot/history')) {
        return Promise.resolve(
          jsonResponse(200, { conversationId: 'c1', messages: [] }),
        );
      }
      return Promise.resolve(jsonResponse(200, []));
    }),
  );
  return calls;
}

const render = () =>
  renderWithI18n(
    <MemoryRouter>
      <ChatbotPopup me={ME} />
    </MemoryRouter>,
  );

describe('ChatbotPopup', () => {
  it('member: welcome + thanh hành động (Tìm máy trống + Máy tôi đang mượn)', async () => {
    stub({ conversationId: 'c1', reply: 'ok', source: 'guided' });
    render();
    await userEvent.click(
      screen.getByRole('button', { name: 'Mở trợ lý QLTS' }),
    );
    expect(screen.getByText('Trợ lý QLTS')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /Tìm máy trống/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Máy tôi đang mượn/ }),
    ).toBeInTheDocument();
    // Member KHÔNG có "Tra cứu tài sản" (chỉ admin)
    expect(
      screen.queryByRole('button', { name: /Tra cứu tài sản/ }),
    ).toBeNull();
  });

  it('bấm "Máy tôi đang mượn" → gọi /chatbot/message (my_borrowings) + render', async () => {
    const calls = stub({
      conversationId: 'c1',
      reply: 'Bạn đang có 1 lượt mượn: POOL-12 (Đang dùng).',
      source: 'guided',
    });
    render();
    await userEvent.click(
      screen.getByRole('button', { name: 'Mở trợ lý QLTS' }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Máy tôi đang mượn/ }),
    );

    expect(
      await screen.findByText(/Bạn đang có 1 lượt mượn/),
    ).toBeInTheDocument();
    const msgCall = calls.find((c) => c.url.includes('/api/chatbot/message'));
    expect(msgCall?.init?.method).toBe('POST');
    expect(msgCall?.init?.body).toContain('my_borrowings');
  });

  it('gõ câu + Enter → gọi /chatbot/message (message)', async () => {
    const calls = stub({
      conversationId: 'c1',
      reply: 'Mình chưa tìm thấy tài sản nào khớp.',
      source: 'fallback',
    });
    render();
    await userEvent.click(
      screen.getByRole('button', { name: 'Mở trợ lý QLTS' }),
    );
    const box = await screen.findByPlaceholderText(/Tìm tài sản/);
    await userEvent.type(box, 'tài sản sắp hết hạn{Enter}');

    const msgCall = calls.find((c) => c.url.includes('/api/chatbot/message'));
    expect(msgCall?.init?.body).toContain('tài sản sắp hết hạn');
    expect(
      await screen.findByText(/chưa tìm thấy tài sản/),
    ).toBeInTheDocument();
  });
});
