import { Global, Module } from '@nestjs/common';
import { SweepService } from './sweep.service';

/**
 * Nền job (AD-9). SweepService là registry dùng chung (handler đăng ký ở story sau).
 * BullMQ Queue/Worker + Redis connection KHỞI TẠO Ở PROCESS WORKER (worker.ts) — API
 * KHÔNG mở kết nối Redis (chỉ ghi outbox trong Postgres).
 */
@Global()
@Module({
  providers: [SweepService],
  exports: [SweepService],
})
export class QueueModule {}
