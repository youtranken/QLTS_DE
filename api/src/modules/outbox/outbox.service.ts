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

/** Dữ liệu consumer cần để quyết baseline + gửi (5.1) — payload chỉ ref, tự đọc lại từ DB. */
export interface OutboxConsumerRow {
  payload: Record<string, unknown>;
  createdAt: Date;
  processedAt: Date | null;
}

export interface FailedNotification {
  id: string;
  topic: string;
  failCount: number;
  lastError: string | null;
  lastFailedAt: Date | null;
}

/**
 * Trần re-drive (review P0 3.2): mỗi chu kỳ relay cạn retry tăng fail_count +1. Chạm trần →
 * relay NGỪNG chọn lại row (row vẫn `processed_at IS NULL`, còn hiện ở listFailed cho SA); chỉ
 * requeue tay (reset fail_count=0) mới hồi sinh. Chặn poison message re-drive vô hạn mỗi 5'.
 */
const MAX_RELAY_ATTEMPTS = 10;

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
   * Relay (F1 + F3): claim event CHƯA XỬ (`processed_at IS NULL`) — không phải "chưa đẩy" —
   * bằng FOR UPDATE SKIP LOCKED (2 relay không tranh chấp), gán lease `claimed_at=now()`;
   * lease hết 5' thì re-drive (row job cạn retry/DLQ hoặc Redis mất job KHÔNG bị nuốt — AD-11,
   * AD-9 "quét lại được"). Consumer check-and-set `processed_at` khi xử xong → hết re-drive.
   *
   * `queue.add` chạy NGOÀI transaction claim (F3: không giữ FOR UPDATE + connection suốt I/O
   * Redis). jobId = event.id (dedup — add lại trong lease/retention KHÔNG sinh job đúp, AD-11
   * at-least-once). add lỗi → lease hết hạn tự re-drive; add xong nhưng crash trước khi consumer
   * mark → job vẫn chạy (jobId còn) hoặc re-drive sau lease. Trả số event đã đẩy.
   */
  async relayBatch(queue: Queue, limit = 100): Promise<number> {
    // 1) Claim + lease trong tx NGẮN (không I/O Redis trong tx).
    const claimed = await this.db.transaction(async (tx) => {
      const rows = await tx.execute<{
        id: string;
        topic: string;
        payload: Record<string, unknown>;
      }>(sql`
        SELECT id, topic, payload FROM outbox
        WHERE processed_at IS NULL
          AND fail_count < ${MAX_RELAY_ATTEMPTS}
          AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `);
      if (rows.rows.length === 0) return [];
      await tx.execute(sql`
        UPDATE outbox SET claimed_at = now()
        WHERE id IN (${sql.join(
          rows.rows.map((r) => sql`${r.id}`),
          sql`, `,
        )})
      `);
      return rows.rows;
    });
    if (claimed.length === 0) return 0;
    // 2) Đẩy vào BullMQ NGOÀI tx. id đặt SAU spread → payload không shadow envelope id.
    for (const ev of claimed) {
      await queue.add(ev.topic, { ...ev.payload, id: ev.id }, { jobId: ev.id });
    }
    this.logger.debug(`relay: ${claimed.length} event`);
    return claimed.length;
  }

  /**
   * Consumer đã xử xong event → check-and-set `processed_at` (idempotent, AD-11 dedup bền):
   * 0 dòng = đã xử trước đó → bỏ qua. Sau khi set, relay KHÔNG re-drive nữa. Trả true nếu
   * lần này là lần mark thật (để consumer quyết gửi mail / skip khi đã xử — Epic 5).
   */
  async markProcessed(eventId: string): Promise<boolean> {
    const r = await this.db.execute<{ id: string }>(sql`
      UPDATE outbox SET processed_at = now()
      WHERE id = ${eventId} AND processed_at IS NULL
      RETURNING id
    `);
    return r.rows.length === 1;
  }

  /**
   * Job cạn retry (DLQ) → ghi marker BỀN vào Postgres (F2): tăng fail_count + last_error để
   * dashboard SA đếm "X thông báo gửi lỗi" (AD-9/AD-11 — không chết im lặng). Row vẫn
   * `processed_at IS NULL` nên relay re-drive tiếp (backstop lỗi tạm thời) CHO ĐẾN khi
   * fail_count chạm MAX_RELAY_ATTEMPTS thì dừng (điểm terminal, review P0 3.2).
   */
  async markFailed(eventId: string, error: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE outbox
      SET fail_count = fail_count + 1, last_error = ${error.slice(0, 1000)},
          last_failed_at = now()
      WHERE id = ${eventId}
    `);
  }

  /** Consumer đọc lại event theo id (5.1): created_at cho baseline, processed_at cho idempotent. */
  async loadForConsumer(eventId: string): Promise<OutboxConsumerRow | null> {
    const r = await this.db.execute<{
      payload: Record<string, unknown>;
      created_at: Date;
      processed_at: Date | null;
    }>(sql`
      SELECT payload, created_at, processed_at FROM outbox WHERE id = ${eventId}
    `);
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      payload: row.payload,
      createdAt: new Date(row.created_at),
      processedAt: row.processed_at ? new Date(row.processed_at) : null,
    };
  }

  /**
   * Badge SA (AD-11): event gửi lỗi CHƯA xử (fail_count>0, processed_at IS NULL). total = tổng
   * để đếm badge; items giới hạn để hiển thị danh sách.
   */
  async listFailed(): Promise<{ total: number; items: FailedNotification[] }> {
    const count = await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM outbox
      WHERE fail_count > 0 AND processed_at IS NULL
    `);
    const r = await this.db.execute<{
      id: string;
      topic: string;
      fail_count: number;
      last_error: string | null;
      last_failed_at: Date | null;
    }>(sql`
      SELECT id, topic, fail_count, last_error, last_failed_at FROM outbox
      WHERE fail_count > 0 AND processed_at IS NULL
      ORDER BY last_failed_at DESC NULLS LAST
      LIMIT 200
    `);
    return {
      total: count.rows[0]?.n ?? 0,
      items: r.rows.map((row) => ({
        id: row.id,
        topic: row.topic,
        failCount: row.fail_count,
        lastError: row.last_error,
        lastFailedAt: row.last_failed_at ? new Date(row.last_failed_at) : null,
      })),
    };
  }

  /** Requeue tay (AC3): reset marker lỗi + lease → relay re-drive event chưa xử. Trả true nếu có. */
  async requeue(eventId: string): Promise<boolean> {
    const r = await this.db.execute<{ id: string }>(sql`
      UPDATE outbox
      SET claimed_at = NULL, fail_count = 0, last_error = NULL, last_failed_at = NULL
      WHERE id = ${eventId} AND processed_at IS NULL
      RETURNING id
    `);
    return r.rows.length === 1;
  }
}
