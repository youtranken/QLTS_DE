import { Injectable, Logger } from '@nestjs/common';

export interface SweepHandler {
  name: string;
  /** Quét Postgres tìm deadline tới hạn + xử lý; PHẢI idempotent (marker trong DB). */
  run: () => Promise<void>;
}

/**
 * Khung sweep định kỳ (AD-9) — Redis chỉ trigger ~1 phút/lần; deadline thật derive từ
 * Postgres nên quét lại được sau khi Redis sống dậy (bù mọi deadline lỡ). Story sau
 * (3.5b auto-expire, 3.8 overdue, 3.9 no-show) đăng ký handler qua register().
 */
@Injectable()
export class SweepService {
  private readonly logger = new Logger(SweepService.name);
  private readonly handlers: SweepHandler[] = [];

  register(handler: SweepHandler): void {
    this.handlers.push(handler);
  }

  /** Chạy MỌI handler; một handler lỗi KHÔNG chặn handler khác (isolation). */
  async runAll(): Promise<void> {
    for (const h of this.handlers) {
      try {
        await h.run();
      } catch (error) {
        this.logger.error(
          `sweep handler '${h.name}' lỗi: ${(error as Error).message}`,
        );
      }
    }
  }

  get registeredCount(): number {
    return this.handlers.length;
  }
}
