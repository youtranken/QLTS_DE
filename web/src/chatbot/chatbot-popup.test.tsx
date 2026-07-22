import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ChatbotPopup } from './chatbot-popup';
import type { Me } from '../me';
import {
  jsonResponse,
  renderWithI18n,
  screen,
  userEvent,
} from '../test/test-utils';

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
  it('mở mascot → welcome + thanh hành động (Danh sách/Máy của tôi/Máy trống)', async () => {
    stub({ conversationId: 'c1', reply: 'ok', source: 'guided' });
    render();
    await userEvent.click(
      screen.getByRole('button', { name: 'Mở trợ lý QLTS' }),
    );
    expect(screen.getByText('Trợ lý QLTS')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /Máy của tôi/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Danh sách/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Máy trống/ }),
    ).toBeInTheDocument();
  });

  it('bấm "Máy của tôi" ở thanh hành động → gọi /chatbot/message (my_assets) + render', async () => {
    const calls = stub({
      conversationId: 'c1',
      reply: 'Bạn đang giữ 2 tài sản:',
      cards: [
        { code: 'M-01', type: 'laptop', holder: null, status: 'in_use', endDate: null },
      ],
      total: 2,
      source: 'guided',
    });
    render();
    await userEvent.click(
      screen.getByRole('button', { name: 'Mở trợ lý QLTS' }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /Máy của tôi/ }),
    );

    expect(await screen.findByText('Bạn đang giữ 2 tài sản:')).toBeInTheDocument();
    expect(screen.getByText('M-01')).toBeInTheDocument();
    const msgCall = calls.find((c) => c.url.includes('/api/chatbot/message'));
    expect(msgCall?.init?.method).toBe('POST');
    expect(msgCall?.init?.body).toContain('my_assets');
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
    const box = await screen.findByPlaceholderText(/Nhập câu hỏi/);
    await userEvent.type(box, 'tài sản sắp hết hạn{Enter}');

    const msgCall = calls.find((c) => c.url.includes('/api/chatbot/message'));
    expect(msgCall?.init?.body).toContain('tài sản sắp hết hạn');
    expect(
      await screen.findByText(/chưa tìm thấy tài sản/),
    ).toBeInTheDocument();
  });
});
