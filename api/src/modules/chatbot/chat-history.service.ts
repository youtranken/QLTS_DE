import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import type { AssetCard } from './chatbot.types';

/**
 * Lưu lịch sử chat — MỘT luồng/người (redesign: bỏ đa-cuộc + drawer). Self-scoped theo
 * `sub`: mở lại thấy đoạn chat cũ; "Xoá đoạn chat" xoá sạch của chính mình.
 */
@Injectable()
export class ChatHistoryService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

  /** Cuộc duy nhất của sub (tạo nếu chưa có). Ưu tiên conversationId hợp lệ của chính sub. */
  async ensureConversation(
    sub: string,
    conversationId: string | undefined,
  ): Promise<string> {
    if (conversationId) {
      const owned = await this.db.execute<{ id: string }>(
        sql`SELECT id FROM chat_conversations WHERE id = ${conversationId} AND sub = ${sub}`,
      );
      if (owned.rows[0]) return conversationId;
    }
    const existing = await this.db.execute<{ id: string }>(
      sql`SELECT id FROM chat_conversations WHERE sub = ${sub} ORDER BY updated_at DESC LIMIT 1`,
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const res = await this.db.execute<{ id: string }>(
      sql`INSERT INTO chat_conversations (sub) VALUES (${sub}) RETURNING id`,
    );
    return res.rows[0].id;
  }

  /** Ghi 1 lượt + bump updated_at. */
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

  /** Luồng duy nhất của sub + toàn bộ message (get-or-create) — FE nạp lúc mở popup. */
  async getSingle(sub: string): Promise<{
    conversationId: string;
    messages: { role: string; content: string; cards: AssetCard[] | null }[];
  }> {
    const conversationId = await this.ensureConversation(sub, undefined);
    const msgs = await this.db.execute<{
      role: string;
      content: string;
      cards: AssetCard[] | null;
    }>(
      sql`SELECT role, content, cards FROM chat_messages WHERE conversation_id = ${conversationId} ORDER BY created_at`,
    );
    return { conversationId, messages: msgs.rows };
  }

  /** Xoá sạch đoạn chat của sub (cascade messages). Lần sau tự tạo cuộc mới. */
  async clear(sub: string): Promise<void> {
    await this.db.execute(
      sql`DELETE FROM chat_conversations WHERE sub = ${sub}`,
    );
  }
}
