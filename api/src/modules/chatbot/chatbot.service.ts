import { Injectable, Logger } from '@nestjs/common';
import { ChatHistoryService } from './chat-history.service';
import { ChatbotGuidedService } from './chatbot-guided.service';
import { ChatbotToolsService } from './chatbot-tools.service';
import { actionLabel, listReply } from './chatbot.helpers';
import type { ChatReply, ChatRequest, Identity } from './chatbot.types';

/**
 * Điều phối chatbot NỘI BỘ (không LLM): guided (nút bấm) render template role-scoped;
 * câu gõ tự do → tìm kiếm tài sản theo từ khoá. Ghi lại cả 2 lượt.
 */
@Injectable()
export class ChatbotService {
  private readonly logger = new Logger(ChatbotService.name);

  constructor(
    private readonly guided: ChatbotGuidedService,
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
      // Lỗi tra cứu → không 500, trả reply thân thiện.
      this.logger.warn(`Tra cứu lỗi: ${(e as Error).message}`);
      reply = {
        reply: 'Xin lỗi, mình gặp lỗi khi tra cứu. Bạn thử lại giúp mình nhé.',
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

  /** Câu gõ tự do → tìm tài sản theo từ khoá (role-scoped). Không dùng LLM. */
  private async handleMessage(
    identity: Identity,
    message: string,
  ): Promise<ChatReply> {
    if (!message.trim()) {
      return {
        reply:
          'Bạn gõ từ khoá (mã máy, tên, cấu hình) hoặc chọn nhanh ở thanh bên dưới giúp mình nhé 🙂',
        source: 'fallback',
      };
    }
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
}
