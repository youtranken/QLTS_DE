import { Injectable, Logger } from '@nestjs/common';
import { ChatHistoryService } from './chat-history.service';
import { ChatbotGuidedService } from './chatbot-guided.service';
import { ChatbotToolsService } from './chatbot-tools.service';
import { GeminiAdapter, type ToolCall } from './gemini.adapter';
import {
  BACK_CHIP,
  actionLabel,
  listReply,
  toAvailabilityParams,
  toFilter,
  todayVn,
} from './chatbot.helpers';
import type { ChatReply, ChatRequest, Identity } from './chatbot.types';

/**
 * Điều phối: guided (nút) vs message (câu gõ → Gemini → tool, hoặc fallback từ khoá).
 * Kết quả tool luôn render bằng template Ở ĐÂY (không nhờ LLM). Ghi lại cả 2 lượt.
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
      } else if (body.message) {
        reply = await this.handleMessage(identity, body.message);
      } else {
        reply = await this.guided.handle(identity, { intent: 'menu' });
      }
    } catch (e) {
      // Lỗi tool (vd khoảng thời gian không hợp lệ) → không 500, trả reply thân thiện.
      this.logger.warn(`Tool lỗi: ${(e as Error).message}`);
      reply = {
        reply:
          'Có lỗi khi xử lý yêu cầu (có thể do khoảng thời gian không hợp lệ). Bạn thử lại hoặc dùng nút bấm nhé.',
        chips: [BACK_CHIP],
        source: 'fallback',
      };
    }

    const convId = await this.history.ensureConversation(
      identity.sub,
      body.conversationId,
      userText || 'Cuộc trò chuyện',
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
      const call = await this.gemini.interpret(message, {
        today: todayVn(),
        role: identity.role,
      });
      if (call) return this.runTool(identity, call);
    }
    // Fallback (thiếu key / Gemini null): coi message như từ khoá tìm kiếm.
    const { cards, total } = await this.tools.searchAssets(identity, {
      search: message,
    });
    return {
      reply: listReply(total, cards.length, true),
      cards,
      total,
      chips: [BACK_CHIP],
      source: 'fallback',
    };
  }

  private async runTool(
    identity: Identity,
    call: ToolCall,
  ): Promise<ChatReply> {
    switch (call.tool) {
      case 'search_assets': {
        const { cards, total } = await this.tools.searchAssets(
          identity,
          toFilter(call.args),
        );
        return {
          reply: listReply(total, cards.length),
          cards,
          total,
          chips: [BACK_CHIP],
          source: 'gemini',
        };
      }
      case 'my_assets': {
        const { cards, total } = await this.tools.myAssets(identity.sub);
        return {
          reply: total
            ? `Bạn đang giữ ${total} tài sản:`
            : 'Bạn chưa giữ tài sản nào.',
          cards,
          total,
          chips: [BACK_CHIP],
          source: 'gemini',
        };
      }
      case 'check_availability': {
        const { from, to, type } = toAvailabilityParams(call.args);
        const { cards, total } = await this.tools.checkAvailability(
          from,
          to,
          type,
        );
        return {
          reply: total
            ? `Có ${total} máy còn trống:`
            : 'Không có máy trống trong khoảng này.',
          cards,
          total,
          chips: [BACK_CHIP],
          source: 'gemini',
        };
      }
    }
  }
}
