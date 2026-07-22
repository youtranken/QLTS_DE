import { Injectable, Logger } from '@nestjs/common';
import { ChatHistoryService } from './chat-history.service';
import { ChatbotGuidedService } from './chatbot-guided.service';
import { ChatbotToolsService } from './chatbot-tools.service';
import { GeminiAdapter, type ToolCall } from './gemini.adapter';
import type { DayAvailability } from '../booking/booking.service';
import {
  actionLabel,
  listReply,
  toAvailabilityParams,
  toFilter,
  todayVn,
} from './chatbot.helpers';
import type { ChatReply, ChatRequest, Identity } from './chatbot.types';

/**
 * Điều phối: guided (nút) render TEMPLATE (không lộ dữ liệu) vs message (câu gõ):
 * Gemini interpret → tool → RAG compose (Gemini soạn câu tự nhiên từ dữ liệu role-scoped),
 * lỗi/thiếu key → template/fallback. Ghi lại cả 2 lượt.
 */
@Injectable()
export class ChatbotService {
  private readonly logger = new Logger(ChatbotService.name);

  constructor(
    private readonly guided: ChatbotGuidedService,
    private readonly gemini: GeminiAdapter,
    private readonly tools: ChatbotToolsService,
    private readonly history: ChatHistoryService,
  ) {}

  async handle(
    identity: Identity,
    body: ChatRequest,
  ): Promise<ChatReply & { conversationId: string }> {
    const userText = body.action
      ? actionLabel(body.action)
      : (body.message ?? '');

    let reply: ChatReply;
    try {
      if (body.action) {
        reply = await this.guided.handle(identity, body.action);
      } else {
        reply = await this.handleMessage(identity, body.message ?? '');
      }
    } catch (e) {
      // Lỗi tool (vd khoảng thời gian không hợp lệ) → không 500, trả reply thân thiện.
      this.logger.warn(`Tool lỗi: ${(e as Error).message}`);
      reply = {
        reply:
          'Xin lỗi, mình gặp lỗi khi xử lý (có thể do khoảng thời gian không hợp lệ). Bạn thử lại giúp mình nhé.',
        source: 'fallback',
      };
    }

    let convId = body.conversationId ?? '';
    try {
      convId = await this.history.ensureConversation(
        identity.sub,
        body.conversationId,
      );
      await this.history.appendTurn(convId, 'user', userText || '(mở đầu)');
      await this.history.appendTurn(
        convId,
        'assistant',
        reply.reply,
        reply.cards,
        reply.detail,
        reply.chips,
      );
    } catch (e) {
      // Lỗi lưu lịch sử (DB blip) KHÔNG được biến câu trả lời đã tính thành HTTP 500.
      this.logger.warn(`Lưu lịch sử lỗi: ${(e as Error).message}`);
    }
    return { conversationId: convId, ...reply };
  }

  private async handleMessage(
    identity: Identity,
    message: string,
  ): Promise<ChatReply> {
    if (!message.trim()) {
      return {
        reply:
          'Bạn gõ câu hỏi hoặc chọn nhanh ở thanh bên dưới giúp mình nhé 🙂',
        source: 'fallback',
      };
    }
    if (this.gemini.isEnabled()) {
      const result = await this.gemini.interpret(message, {
        today: todayVn(),
        role: identity.role,
      });
      if (result) {
        // Gemini chọn tool (hỏi tài sản) → thực thi; ngược lại là câu chào/ngoài phạm vi.
        if ('tool' in result) return this.runTool(identity, result, message);
        return { reply: result.text, source: 'gemini' };
      }
    }
    // Fallback (thiếu key / Gemini null): coi message như từ khoá tìm kiếm.
    const { cards, total } = await this.tools.searchAssets(identity, {
      search: message,
    });
    return {
      reply: listReply(total, cards.length, true),
      cards,
      total,
      source: 'fallback',
    };
  }

  private async runTool(
    identity: Identity,
    call: ToolCall,
    message: string,
  ): Promise<ChatReply> {
    switch (call.tool) {
      case 'search_assets': {
        const { cards, total } = await this.tools.searchAssets(
          identity,
          toFilter(call.args),
        );
        const reply = await this.compose(
          message,
          call,
          { total, items: cards },
          identity,
          listReply(total, cards.length),
        );
        return {
          reply,
          cards,
          total,
          chips: [
            { label: '🔎 Lọc loại khác', action: { intent: 'list_types' } },
          ],
          source: 'gemini',
        };
      }
      case 'my_assets': {
        const { cards, total } = await this.tools.myAssets(identity.sub);
        const reply = await this.compose(
          message,
          call,
          { total, items: cards },
          identity,
          total
            ? `Bạn đang giữ ${total} tài sản:`
            : 'Hiện bạn không giữ tài sản nào.',
        );
        return { reply, cards, total, source: 'gemini' };
      }
      case 'check_availability': {
        const { from, to, type } = toAvailabilityParams(call.args);
        const { cards, total } = await this.tools.checkAvailability(
          from,
          to,
          type,
        );
        const reply = await this.compose(
          message,
          call,
          { total, machines: cards },
          identity,
          total
            ? `Có ${total} máy còn trống trong khung giờ này:`
            : 'Tiếc quá, không có máy nào trống trong khung giờ này.',
        );
        return { reply, cards, total, source: 'gemini' };
      }
      case 'day_availability': {
        const date =
          typeof call.args.date === 'string'
            ? call.args.date.trim()
            : todayVn();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return {
            reply: `Mình chưa nhận ra ngày "${date}". Bạn cho mình ngày cụ thể (ngày/tháng/năm) nhé.`,
            source: 'gemini',
          };
        }
        if (date < todayVn()) {
          return {
            reply: `Ngày ${date} đã qua rồi. Mình chỉ xem được khung giờ trống từ hôm nay trở đi.`,
            source: 'gemini',
          };
        }
        const type =
          typeof call.args.type === 'string' && call.args.type.trim()
            ? call.args.type.trim()
            : undefined;
        const data = await this.tools.dayAvailability(date, type);
        const reply = await this.compose(
          message,
          call,
          data,
          identity,
          daySlotsTemplate(data),
        );
        return { reply, source: 'gemini' };
      }
      case 'asset_stats': {
        const stats = await this.tools.assetStats(identity);
        const reply = await this.compose(
          message,
          call,
          stats,
          identity,
          `Tổng ${stats.tongSo} tài sản, giá trị ${stats.tongGiaTri}, sắp hết hạn (30 ngày): ${stats.sapHetHan30Ngay}.`,
        );
        return { reply, source: 'gemini' };
      }
      case 'my_borrowings': {
        const list = await this.tools.myBorrowings(identity.sub);
        const reply = await this.compose(
          message,
          call,
          { borrowings: list },
          identity,
          list.length
            ? `Bạn đang có ${list.length} yêu cầu/lượt mượn.`
            : 'Bạn hiện không mượn máy nào.',
        );
        return { reply, source: 'gemini' };
      }
      case 'pending_approvals': {
        const data = await this.tools.pendingApprovals(identity);
        if (!data) {
          return {
            reply: 'Chỉ admin mới xem được hàng chờ duyệt/gia hạn.',
            source: 'gemini',
          };
        }
        const reply = await this.compose(
          message,
          call,
          data,
          identity,
          `Có ${data.soChoDuyet} yêu cầu chờ duyệt và ${data.soChoGiaHan} chờ gia hạn. Bạn vào mục "Xử lý mượn" để duyệt.`,
        );
        return { reply, source: 'gemini' };
      }
      case 'software_info': {
        const name =
          typeof call.args.name === 'string' && call.args.name.trim()
            ? call.args.name.trim()
            : undefined;
        const data = await this.tools.softwareInfo(identity, name);
        if (!data) {
          return {
            reply: 'Thông tin phần mềm/license chỉ admin xem được.',
            source: 'gemini',
          };
        }
        const reply = await this.compose(
          message,
          call,
          data,
          identity,
          data.soLicense
            ? `Có ${data.soLicense} license.`
            : 'Không tìm thấy license nào khớp.',
        );
        return { reply, source: 'gemini' };
      }
      case 'asset_history': {
        const code =
          typeof call.args.code === 'string' ? call.args.code.trim() : '';
        const data = code
          ? await this.tools.assetHistory(identity, code)
          : null;
        if (!data) {
          const isMember = !(
            identity.role === 'admin' || identity.role === 'sa'
          );
          return {
            reply: `Chưa có lịch sử cấp phát cho máy ${code || 'này'}${isMember ? ' (hoặc bạn không có quyền xem)' : ''}.`,
            source: 'gemini',
          };
        }
        const reply = await this.compose(
          message,
          call,
          data,
          identity,
          `Lịch sử cấp phát máy ${data.code}:`,
        );
        return { reply, source: 'gemini' };
      }
      case 'get_asset': {
        const code =
          typeof call.args.code === 'string' ? call.args.code.trim() : '';
        const aspects = Array.isArray(call.args.aspects)
          ? call.args.aspects.filter((a): a is string => typeof a === 'string')
          : [];
        const detail = code
          ? await this.tools.getAsset(identity, code, aspects)
          : null;
        if (!detail) {
          const isMember = !(
            identity.role === 'admin' || identity.role === 'sa'
          );
          return {
            reply: isMember
              ? `Không tìm thấy máy ${code || 'này'} trong danh sách bạn đang giữ.`
              : `Không tìm thấy máy ${code || 'này'}.`,
            source: 'gemini',
          };
        }
        const reply = await this.compose(
          message,
          call,
          detail,
          identity,
          `Chi tiết ${detail.code}:`,
        );
        return { reply, detail, source: 'gemini' };
      }
    }
  }

  /** RAG bước 2: đưa dữ liệu (role-scoped) cho Gemini soạn câu trả lời; lỗi → template. */
  private async compose(
    message: string,
    call: ToolCall,
    data: unknown,
    identity: Identity,
    fallback: string,
  ): Promise<string> {
    const text = await this.gemini.compose(
      message,
      call.tool,
      call.args,
      data,
      { today: todayVn(), role: identity.role },
      call.thoughtSignature,
    );
    return text ?? fallback;
  }
}

/** Template khung giờ trống (fallback khi compose lỗi). */
function daySlotsTemplate(d: DayAvailability): string {
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
          `${m.code} (${m.freeSlots.map((s) => `${s.from}–${s.to}`).join(', ')})`,
      )
      .join('; ') +
    '.'
  );
}
