import { BadRequestException, Injectable } from '@nestjs/common';
import { ChatbotToolsService } from './chatbot-tools.service';
import {
  BACK_CHIP,
  listReply,
  toAvailabilityParams,
  toFilter,
} from './chatbot.helpers';
import type { ChatReply, Chip, GuidedAction, Identity } from './chatbot.types';

const MENU_CHIPS: Chip[] = [
  { label: '📋 Xem danh sách tài sản', action: { intent: 'list_types' } },
  { label: '🔧 Máy của tôi', action: { intent: 'my_assets' } },
  { label: '🗓️ Tìm máy trống', action: { intent: 'availability' } },
];

/**
 * Bộ não "dẫn dắt" — deterministic, không cần LLM ($0/offline). Stateless: FE giữ bước,
 * mỗi chip gửi {intent, params}; service thực thi tool + trả chip bước kế.
 */
@Injectable()
export class ChatbotGuidedService {
  constructor(private readonly tools: ChatbotToolsService) {}

  async handle(identity: Identity, action: GuidedAction): Promise<ChatReply> {
    switch (action.intent) {
      case 'menu':
        return {
          reply: 'Chào bạn 👋 Mình là trợ lý QLTS. Bạn cần gì?',
          chips: MENU_CHIPS,
          source: 'guided',
        };

      case 'list_types': {
        const types = await this.tools.assetTypes();
        const chips: Chip[] = [
          { label: 'Tất cả', action: { intent: 'list_result', params: {} } },
          ...types.map((t) => ({
            label: t,
            action: { intent: 'list_result', params: { type: t } },
          })),
        ];
        return { reply: 'Bạn muốn xem loại nào?', chips, source: 'guided' };
      }

      case 'list_result': {
        const { cards, total } = await this.tools.searchAssets(
          identity,
          toFilter(action.params),
        );
        return {
          reply: listReply(total, cards.length),
          cards,
          total,
          chips: [
            { label: 'Lọc loại khác', action: { intent: 'list_types' } },
            BACK_CHIP,
          ],
          source: 'guided',
        };
      }

      case 'my_assets': {
        const { cards, total } = await this.tools.myAssets(identity.sub);
        return {
          reply: total
            ? `Bạn đang giữ ${total} tài sản${total > cards.length ? ` (hiển thị ${cards.length})` : ''}:`
            : 'Bạn chưa giữ tài sản nào.',
          cards,
          total,
          chips: [BACK_CHIP],
          source: 'guided',
        };
      }

      case 'availability': {
        const { from, to, type } = toAvailabilityParams(action.params);
        const { cards, total } = await this.tools.checkAvailability(
          from,
          to,
          type,
        );
        return {
          reply: total
            ? `Có ${total} máy còn trống${total > cards.length ? ` (hiển thị ${cards.length})` : ''}:`
            : 'Không có máy trống trong khoảng này.',
          cards,
          total,
          chips: [BACK_CHIP],
          source: 'guided',
        };
      }

      default:
        throw new BadRequestException({
          code: 'CHATBOT_BAD_INTENT',
          message: `Không hiểu yêu cầu: ${action.intent}`,
        });
    }
  }
}
