import { GeminiAdapter } from './gemini.adapter';

/** Unit: Gemini adapter — parse functionCall; lỗi/timeout/no-key → null; MỘT-chặng. */
describe('GeminiAdapter', () => {
  const OLD = process.env.GEMINI_API_KEY;
  let adapter: GeminiAdapter;

  const okJson = (body: unknown) =>
    ({ ok: true, json: () => Promise.resolve(body) }) as unknown as Response;

  beforeEach(() => {
    adapter = new GeminiAdapter();
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = OLD;
    jest.restoreAllMocks();
  });

  it('thiếu key → isEnabled false + interpret null, KHÔNG gọi fetch', async () => {
    delete process.env.GEMINI_API_KEY;
    const spy = jest.spyOn(globalThis, 'fetch');
    expect(adapter.isEnabled()).toBe(false);
    expect(
      await adapter.interpret('x', { today: '2026-07-22', role: 'member' }),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('functionCall hợp lệ → {tool,args}; CHỈ gọi fetch 1 lần (không chặng 2 kèm dữ liệu)', async () => {
    process.env.GEMINI_API_KEY = 'k';
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'search_assets',
                    args: { type: 'laptop' },
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const r = await adapter.interpret('laptop nào', {
      today: '2026-07-22',
      role: 'admin',
    });
    expect(r).toEqual({ tool: 'search_assets', args: { type: 'laptop' } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('tên hàm ngoài whitelist → null (chống leo thang)', async () => {
    process.env.GEMINI_API_KEY = 'k';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'delete_all', args: {} } }],
            },
          },
        ],
      }),
    );
    expect(
      await adapter.interpret('x', { today: 't', role: 'member' }),
    ).toBeNull();
  });

  it('chào hỏi (không functionCall, chỉ text) → trả {text}, KHÔNG tra tài sản', async () => {
    process.env.GEMINI_API_KEY = 'k';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({
        candidates: [
          {
            content: {
              parts: [{ text: 'Chào bạn! Mình giúp tra cứu tài sản nhé.' }],
            },
          },
        ],
      }),
    );
    const r = await adapter.interpret('hello', { today: 't', role: 'member' });
    expect(r).toEqual({ text: 'Chào bạn! Mình giúp tra cứu tài sản nhé.' });
  });

  it('HTTP lỗi → null', async () => {
    process.env.GEMINI_API_KEY = 'k';
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: false, status: 429 } as unknown as Response);
    expect(
      await adapter.interpret('x', { today: 't', role: 'member' }),
    ).toBeNull();
  });

  it('fetch throw (timeout) → null', async () => {
    process.env.GEMINI_API_KEY = 'k';
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('aborted'));
    expect(
      await adapter.interpret('x', { today: 't', role: 'member' }),
    ).toBeNull();
  });

  it('compose (RAG bước 2) → câu trả lời tự nhiên từ dữ liệu', async () => {
    process.env.GEMINI_API_KEY = 'k';
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      okJson({
        candidates: [
          { content: { parts: [{ text: 'Máy rẻ nhất là LAP-01.' }] } },
        ],
      }),
    );
    const r = await adapter.compose(
      'máy nào rẻ nhất',
      'search_assets',
      {},
      { items: [] },
      { today: 't', role: 'admin' },
    );
    expect(r).toBe('Máy rẻ nhất là LAP-01.');
  });

  it('compose lỗi → null (orchestrator dùng template)', async () => {
    process.env.GEMINI_API_KEY = 'k';
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('x'));
    expect(
      await adapter.compose(
        'q',
        'search_assets',
        {},
        {},
        {
          today: 't',
          role: 'admin',
        },
      ),
    ).toBeNull();
  });
});
