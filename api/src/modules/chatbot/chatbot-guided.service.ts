import { BadRequestException, Injectable } from '@nestjs/common';
import { ChatbotToolsService } from './chatbot-tools.service';
import { listReply, toAvailabilityParams, toFilter } from './chatbot.helpers';
import type { ChatReply, Chip, GuidedAction, Identity } from './chatbot.types';

/**
 * Bộ não "dẫn dắt" — deterministic, không cần LLM ($0/offline). Stateless: FE giữ bước,
 * mỗi chip gửi {intent, params}; service thực thi tool + trả chip bước kế.
 */
@Injectable()
export class ChatbotGuidedService {
  constructor(private readonly tools: ChatbotToolsService) {}

  async handle(identity: Identity, action: GuidedAction): Promise<ChatReply> {
    switch (action.intent) {
      case 'list_types': {
        const types = await this.tools.assetTypes();
        const chips: Chip[] = [
          { label: 'Tất cả', action: { intent: 'list_result', params: {} } },
          ...types.map((t) => ({
            label: t,
            action: { intent: 'list_result', params: { type: t } },
          })),
        ];
        return {
          reply: 'Bạn muốn xem loại tài sản nào?',
          chips,
          source: 'guided',
        };
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
            { label: '🔎 Lọc loại khác', action: { intent: 'list_types' } },
          ],
          source: 'guided',
        };
      }

      case 'my_assets': {
        const { cards, total } = await this.tools.myAssets(identity.sub);
        return {
          reply: total
            ? `Bạn đang giữ ${total} tài sản${total > cards.length ? ` (hiển thị ${cards.length} đầu)` : ''}:`
            : 'Hiện bạn không giữ tài sản nào.',
          cards,
          total,
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
            ? `Có ${total} máy còn trống trong khung giờ này${total > cards.length ? ` (hiển thị ${cards.length} đầu)` : ''}:`
            : 'Tiếc quá, không có máy nào trống trong khung giờ này.',
          cards,
          total,
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
