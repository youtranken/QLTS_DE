import type { ConnectionOptions, JobsOptions } from 'bullmq';

/** Tên queue BullMQ — một nguồn, worker + relay dùng chung. KHÔNG chứa ':' (BullMQ 5 cấm). */
export const EVENTS_QUEUE = 'qlts-events';
export const SWEEP_QUEUE = 'qlts-sweep';

/**
 * Job options chuẩn (AD-9): retry 5 lần backoff mũ → cạn thì vào failed (DLQ).
 * removeOnComplete GIỮ theo cửa sổ (không xóa ngay) — jobId dedup còn hiệu lực trong
 * cửa sổ crash relay-trước-commit (M3 review); Dedup BỀN thật do consumer check-and-set
 * outbox.processed_at (F1). KHÔNG dùng removeOnComplete:true.
 * removeOnFail:true (F2): xóa job failed NGAY ở BullMQ để relay re-drive được (jobId rảnh);
 * bằng chứng DLQ bền nằm ở outbox.fail_count/last_error (Postgres), không ở Redis.
 */
export const EVENTS_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 5_000 },
  removeOnFail: true,
};

/** Sweep-tick: retry + xóa completed (idempotent, không cần giữ) nhưng giữ failed để soi. */
export const SWEEP_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: true,
  removeOnFail: { age: 86_400 },
};

/**
 * ConnectionOptions cho BullMQ parse từ REDIS_URL. Trả plain object (không IORedis
 * instance) để BullMQ tự tạo kết nối bằng ioredis bundled của nó (tránh xung đột 2 bản
 * ioredis). `maxRetriesPerRequest: null` BẮT BUỘC cho BullMQ blocking commands; noeviction
 * cấu hình phía Redis (docker-compose). Trả null nếu thiếu REDIS_URL.
 */
export function redisConnectionOptions(
  url: string | undefined,
): ConnectionOptions | null {
  if (!url) return null;
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    maxRetriesPerRequest: null,
  };
}
