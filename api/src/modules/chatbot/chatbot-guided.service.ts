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

      case 'my_borrowings': {
        const list = await this.tools.myBorrowings(identity.sub);
        return {
          reply: list.length
            ? `Bạn đang có ${list.length} lượt mượn: ` +
              list
                .map(
                  (b) =>
                    `${b.may ?? '—'} (${b.trangThai}${b.quaHan ? ', QUÁ HẠN' : ''})`,
                )
                .join(', ') +
              '. Xem chi tiết/hạn trả ở trang chủ.'
            : 'Bạn hiện không mượn máy nào.',
          source: 'guided',
        };
      }

      case 'pending_approvals': {
        const data = await this.tools.pendingApprovals(identity);
        if (!data) {
          return {
            reply: 'Chỉ admin mới xem được hàng chờ duyệt/gia hạn.',
            source: 'guided',
          };
        }
        return {
          reply:
            data.soChoDuyet || data.soChoGiaHan
              ? `Có ${data.soChoDuyet} yêu cầu chờ duyệt và ${data.soChoGiaHan} chờ gia hạn. Bạn vào mục "Xử lý mượn" để duyệt.`
              : 'Hiện không có yêu cầu nào chờ duyệt hoặc chờ gia hạn.',
          source: 'guided',
        };
      }

      case 'eol_alerts': {
        const data = await this.tools.eolAlerts(identity);
        if (!data) {
          return {
            reply: 'Chỉ admin mới xem được cảnh báo EOL (thanh lý/hết hạn).',
            source: 'guided',
          };
        }
        if (!data.soMayCanThanhLy && !data.soLicenseSapHetHan) {
          return {
            reply: 'Hiện không có máy hay license nào sắp/đã hết hạn. 👍',
            source: 'guided',
          };
        }
        const daysLabel = (n: number) =>
          n <= 0 ? `quá hạn ${Math.abs(n)} ngày` : `còn ${n} ngày`;
        const parts: string[] = [];
        if (data.soMayCanThanhLy) {
          const top = data.may
            .slice(0, 5)
            .map((m) => `${m.ma ?? '—'} (${daysLabel(m.conLaiNgay)})`)
            .join(', ');
          parts.push(
            `${data.soMayCanThanhLy} máy sắp/đã hết hạn: ${top}${data.soMayCanThanhLy > 5 ? '…' : ''}`,
          );
        }
        if (data.soLicenseSapHetHan) {
          const top = data.license
            .slice(0, 5)
            .map((s) => `${s.ten ?? '—'} (${daysLabel(s.conLaiNgay)})`)
            .join(', ');
          parts.push(
            `${data.soLicenseSapHetHan} license sắp/đã hết hạn: ${top}${data.soLicenseSapHetHan > 5 ? '…' : ''}`,
          );
        }
        return {
          reply: `${parts.join('. ')}. Vào mục "Cảnh báo EOL" để chọn và thanh lý.`,
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
