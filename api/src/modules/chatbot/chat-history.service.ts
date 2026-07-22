import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import type { AssetCard, AssetDetail, Chip } from './chatbot.types';

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
    // Upsert atomic: UNIQUE(sub) (0043) + ON CONFLICT → get-or-create không race
    // (2 tab / openChat+gửi song song không còn tạo được cuộc trùng).
    const res = await this.db.execute<{ id: string }>(
      sql`INSERT INTO chat_conversations (sub) VALUES (${sub})
          ON CONFLICT (sub) DO UPDATE SET updated_at = chat_conversations.updated_at
          RETURNING id`,
    );
    return res.rows[0].id;
  }

  /** Ghi 1 lượt + bump updated_at. Lưu cả detail/chips để mở lại thấy nguyên (0043). */
  async appendTurn(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    cards?: AssetCard[],
    detail?: AssetDetail,
    chips?: Chip[],
  ): Promise<void> {
    const jsonb = (v: unknown) =>
      v ? sql`${JSON.stringify(v)}::jsonb` : sql`NULL`;
    await this.db.execute(
      sql`INSERT INTO chat_messages (conversation_id, role, content, cards, detail, chips)
          VALUES (${conversationId}, ${role}, ${content}, ${jsonb(cards)}, ${jsonb(detail)}, ${jsonb(chips)})`,
    );
    await this.db.execute(
      sql`UPDATE chat_conversations SET updated_at = now() WHERE id = ${conversationId}`,
    );
  }

  /** Luồng duy nhất của sub + toàn bộ message (get-or-create) — FE nạp lúc mở popup. */
  async getSingle(sub: string): Promise<{
    conversationId: string;
    messages: {
      role: string;
      content: string;
      cards: AssetCard[] | null;
      detail: AssetDetail | null;
      chips: Chip[] | null;
    }[];
  }> {
    const conversationId = await this.ensureConversation(sub, undefined);
    const msgs = await this.db.execute<{
      role: string;
      content: string;
      cards: AssetCard[] | null;
      detail: AssetDetail | null;
      chips: Chip[] | null;
    }>(
      sql`SELECT role, content, cards, detail, chips FROM chat_messages WHERE conversation_id = ${conversationId} ORDER BY created_at`,
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
