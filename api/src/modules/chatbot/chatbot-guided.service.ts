import { BadRequestException, Injectable } from '@nestjs/common';
import type { DayAvailability } from '../booking/booking.service';
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

      case 'day_availability': {
        const date =
          typeof action.params?.date === 'string' ? action.params?.date : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return {
            reply:
              'Bạn cho mình ngày cụ thể (vd 03/08 hoặc "ngày mai") để xem khung giờ trống nhé.',
            source: 'guided',
          };
        }
        const data = await this.tools.dayAvailability(date);
        return { reply: daySlotsReply(data), source: 'guided' };
      }

      case 'get_asset': {
        const code =
          typeof action.params?.code === 'string' ? action.params?.code.trim() : '';
        const detail = code
          ? await this.tools.getAsset(identity, code, [])
          : null;
        if (!detail) {
          const member = !(identity.role === 'admin' || identity.role === 'sa');
          return {
            reply: member
              ? `Không tìm thấy máy ${code || 'này'} trong danh sách bạn đang giữ.`
              : `Không tìm thấy máy ${code || 'này'}.`,
            source: 'guided',
          };
        }
        return { reply: `Chi tiết ${detail.code}:`, detail, source: 'guided' };
      }

      case 'asset_stats': {
        const s = await this.tools.assetStats(identity);
        return {
          reply: `Tổng ${s.tongSo} tài sản, giá trị ${s.tongGiaTri}, sắp hết hạn (30 ngày): ${s.sapHetHan30Ngay}.`,
          source: 'guided',
        };
      }

      case 'software_info': {
        const data = await this.tools.softwareInfo(identity);
        if (!data) {
          return {
            reply: 'Thông tin phần mềm/license chỉ admin xem được.',
            source: 'guided',
          };
        }
        return {
          reply: data.soLicense
            ? `Có ${data.soLicense} license đang quản lý. Vào mục "Phần mềm" để xem chi tiết.`
            : 'Không tìm thấy license nào khớp.',
          source: 'guided',
        };
      }

      case 'asset_history': {
        const code =
          typeof action.params?.code === 'string' ? action.params?.code.trim() : '';
        const data = code ? await this.tools.assetHistory(identity, code) : null;
        if (!data) {
          const member = !(identity.role === 'admin' || identity.role === 'sa');
          return {
            reply: `Chưa có lịch sử cấp phát cho máy ${code || 'này'}${member ? ' (hoặc bạn không có quyền xem)' : ''}.`,
            source: 'guided',
          };
        }
        const lines = data.lichSu
          .slice(0, 5)
          .map(
            (h) =>
              `${isoDate(h.ngay)}: ${h.tu ?? '—'} → ${h.den ?? '—'}${h.boi ? ` (bởi ${h.boi})` : ''}`,
          )
          .join('; ');
        return {
          reply: `Lịch sử cấp phát máy ${data.code}: ${lines}.`,
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

/** Ngày (Date/chuỗi) → YYYY-MM-DD cho dòng lịch sử. */
function isoDate(v: unknown): string {
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

/** Câu tóm tắt khung giờ trống trong MỘT ngày (template thuần, không LLM). */
function daySlotsReply(d: DayAvailability): string {
  if (!d.isWorkingDay) {
    return `Ngày ${d.date} không phải ngày làm việc (giờ làm ${d.start}–${d.end}).`;
  }
  const free = d.machines.filter((m) => m.freeSlots.length);
  if (!free.length) {
    return `Ngày ${d.date} không còn máy nào có khung giờ trống.`;
  }
  return (
    `Khung giờ trống ngày ${d.date}: ` +
    free
      .map(
        (m) =>
          `${m.code ?? '—'} (${m.freeSlots.map((s) => `${s.from}–${s.to}`).join(', ')})`,
      )
      .join('; ') +
    '.'
  );
}
