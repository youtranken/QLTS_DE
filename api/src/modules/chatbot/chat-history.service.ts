import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import type { AssetCard } from './chatbot.types';

const NOT_FOUND = {
  code: 'CHAT_CONV_NOT_FOUND',
  message: 'Không tìm thấy cuộc trò chuyện.',
};

/**
 * Lưu lịch sử chat theo `sub` (AC6). Self-scoped tuyệt đối — mọi thao tác kiểm chủ
 * theo sub (chống IDOR): member A không đọc/xoá được cuộc của member B.
 */
@Injectable()
export class ChatHistoryService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

  /** Cuộc hiện tại nếu là của sub; ngược lại (thiếu/không thuộc sub) → tạo mới. */
  async ensureConversation(
    sub: string,
    conversationId: string | undefined,
    firstText: string,
  ): Promise<string> {
    if (conversationId) {
      const owned = await this.db.execute<{ id: string }>(
        sql`SELECT id FROM chat_conversations WHERE id = ${conversationId} AND sub = ${sub}`,
      );
      if (owned.rows[0]) return conversationId;
    }
    const res = await this.db.execute<{ id: string }>(
      sql`INSERT INTO chat_conversations (sub, title) VALUES (${sub}, ${firstText.slice(0, 60)}) RETURNING id`,
    );
    return res.rows[0].id;
  }

  /** Ghi 1 lượt + bump updated_at (G10) để sidebar sắp mới→cũ. */
  async appendTurn(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    cards?: AssetCard[],
  ): Promise<void> {
    const cardsFragment = cards
      ? sql`${JSON.stringify(cards)}::jsonb`
      : sql`NULL`;
    await this.db.execute(
      sql`INSERT INTO chat_messages (conversation_id, role, content, cards) VALUES (${conversationId}, ${role}, ${content}, ${cardsFragment})`,
    );
    await this.db.execute(
      sql`UPDATE chat_conversations SET updated_at = now() WHERE id = ${conversationId}`,
    );
  }

  async listConversations(sub: string) {
    const res = await this.db.execute<{
      id: string;
      title: string | null;
      updated_at: Date;
    }>(
      sql`SELECT id, title, updated_at FROM chat_conversations WHERE sub = ${sub} ORDER BY updated_at DESC LIMIT 100`,
    );
    return res.rows;
  }

  async getMessages(sub: string, conversationId: string) {
    const owned = await this.db.execute<{ id: string }>(
      sql`SELECT id FROM chat_conversations WHERE id = ${conversationId} AND sub = ${sub}`,
    );
    if (!owned.rows[0]) throw new NotFoundException(NOT_FOUND);
    const res = await this.db.execute<{
      role: string;
      content: string;
      cards: AssetCard[] | null;
      created_at: Date;
    }>(
      sql`SELECT role, content, cards, created_at FROM chat_messages WHERE conversation_id = ${conversationId} ORDER BY created_at`,
    );
    return res.rows;
  }

  async newConversation(sub: string): Promise<{ id: string }> {
    const res = await this.db.execute<{ id: string }>(
      sql`INSERT INTO chat_conversations (sub, title) VALUES (${sub}, NULL) RETURNING id`,
    );
    return { id: res.rows[0].id };
  }

  async deleteConversation(sub: string, conversationId: string): Promise<void> {
    const res = await this.db.execute<{ id: string }>(
      sql`DELETE FROM chat_conversations WHERE id = ${conversationId} AND sub = ${sub} RETURNING id`,
    );
    if (!res.rows[0]) throw new NotFoundException(NOT_FOUND);
  }
}
