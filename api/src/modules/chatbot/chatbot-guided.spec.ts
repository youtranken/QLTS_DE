import { BadRequestException } from '@nestjs/common';
import { ChatbotGuidedService } from './chatbot-guided.service';
import { ChatbotToolsService } from './chatbot-tools.service';
import type { AssetCard, Identity } from './chatbot.types';

/** Unit: guided map intent → tool + chips (không DB, mock tools). Story 12.1 AC3. */
describe('ChatbotGuidedService', () => {
  const identity: Identity = { sub: 'u1', role: 'member' };
  let tools: {
    assetTypes: jest.Mock;
    searchAssets: jest.Mock;
    myAssets: jest.Mock;
    checkAvailability: jest.Mock;
  };
  let guided: ChatbotGuidedService;

  const card: AssetCard = {
    code: 'x',
    type: 'laptop',
    holder: null,
    status: 'in_use',
    endDate: null,
  };

  beforeEach(() => {
    tools = {
      assetTypes: jest.fn(),
      searchAssets: jest.fn(),
      myAssets: jest.fn(),
      checkAvailability: jest.fn(),
    };
    guided = new ChatbotGuidedService(tools as unknown as ChatbotToolsService);
  });

  it('menu → 3 chip, không gọi tool', async () => {
    const r = await guided.handle(identity, { intent: 'menu' });
    expect(r.source).toBe('guided');
    expect(r.chips?.map((c) => c.action.intent)).toEqual([
      'list_types',
      'my_assets',
      'availability',
    ]);
  });

  it('list_types → chip Tất cả + từng loại', async () => {
    tools.assetTypes.mockResolvedValue(['laptop', 'pc']);
    const r = await guided.handle(identity, { intent: 'list_types' });
    expect(tools.assetTypes).toHaveBeenCalled();
    expect(r.chips?.map((c) => c.label)).toEqual(['Tất cả', 'laptop', 'pc']);
    expect(r.chips?.[1].action).toEqual({
      intent: 'list_result',
      params: { type: 'laptop' },
    });
  });

  it('list_result → searchAssets + reply "hiển thị N/tổng M"', async () => {
    tools.searchAssets.mockResolvedValue({
      cards: Array<AssetCard>(8).fill(card),
      total: 20,
    });
    const r = await guided.handle(identity, {
      intent: 'list_result',
      params: { type: 'laptop' },
    });
    expect(tools.searchAssets).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ type: 'laptop' }),
    );
    expect(r.reply).toContain('hiển thị 8/tổng 20');
    expect(r.cards).toHaveLength(8);
  });

  it('my_assets → myAssets(sub)', async () => {
    tools.myAssets.mockResolvedValue({ cards: [], total: 0 });
    const r = await guided.handle(identity, { intent: 'my_assets' });
    expect(tools.myAssets).toHaveBeenCalledWith('u1');
    expect(r.reply).toContain('chưa giữ');
  });

  it('availability thiếu ngày → mặc định hôm nay 07:00–18:00 (+07:00)', async () => {
    tools.checkAvailability.mockResolvedValue({ cards: [], total: 0 });
    await guided.handle(identity, { intent: 'availability' });
    const [from, to] = tools.checkAvailability.mock.calls[0] as [
      string,
      string,
    ];
    expect(from).toMatch(/T07:00:00\+07:00$/);
    expect(to).toMatch(/T18:00:00\+07:00$/);
  });

  it('intent lạ → BadRequest (không 500)', async () => {
    await expect(
      guided.handle(identity, { intent: 'xyz' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
