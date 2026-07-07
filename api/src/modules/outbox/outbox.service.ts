import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';

export interface OutboxEvent {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

  /**
   * Ghi sự kiện nghiệp vụ vào outbox TRONG transaction nghiệp vụ (AD-11) — enqueue
   * sang BullMQ tách rời (relay). Payload CHỈ id tham chiếu, KHÔNG PII.
   */
  async enqueueWithin(
    tx: Pick<Database, 'execute'>,
    topic: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.execute(sql`
      INSERT INTO outbox (topic, payload) VALUES (${topic}, ${JSON.stringify(payload)}::jsonb)
    `);
  }

  /**
   * Relay: claim event chưa đẩy bằng FOR UPDATE SKIP LOCKED (2 relay không tranh chấp),
   * add vào BullMQ với jobId = event.id (dedup — crash giữa add-và-mark KHÔNG sinh job đúp,
   * AD-11 at-least-once). Giữ row lock suốt add trong MỘT transaction: add xong mới mark
   * claimed_at; add lỗi → tx rollback → claimed_at không set → lần sau thử lại.
   * Trả số event đã relay.
   */
  async relayBatch(queue: Queue, limit = 100): Promise<number> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.execute<{
        id: string;
        topic: string;
        payload: Record<string, unknown>;
      }>(sql`
        SELECT id, topic, payload FROM outbox
        WHERE claimed_at IS NULL
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `);
      if (claimed.rows.length === 0) return 0;
      for (const ev of claimed.rows) {
        // jobId = id → BullMQ bỏ qua nếu đã tồn tại (idempotent relay).
        // id đặt SAU spread → payload không thể shadow envelope id (L2 review).
        await queue.add(
          ev.topic,
          { ...ev.payload, id: ev.id },
          { jobId: ev.id },
        );
      }
      const ids = claimed.rows.map((r) => r.id);
      await tx.execute(sql`
        UPDATE outbox SET claimed_at = now()
        WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
      `);
      this.logger.debug(`relay: ${ids.length} event`);
      return ids.length;
    });
  }
}
