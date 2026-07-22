import { Injectable, Logger } from '@nestjs/common';
import { ChatHistoryService } from './chat-history.service';
import { ChatbotGuidedService } from './chatbot-guided.service';
import { ChatbotToolsService } from './chatbot-tools.service';
import { GeminiAdapter, type ToolCall } from './gemini.adapter';
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

    const convId = await this.history.ensureConversation(
      identity.sub,
      body.conversationId,
    );
    await this.history.appendTurn(convId, 'user', userText || '(mở đầu)');
    await this.history.appendTurn(
      convId,
      'assistant',
      reply.reply,
      reply.cards,
    );
    return { conversationId: convId, ...reply };
  }

  private async handleMessage(
    identity: Identity,
    message: string,
  ): Promise<ChatReply> {
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
