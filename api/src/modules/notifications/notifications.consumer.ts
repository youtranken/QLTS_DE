import { Injectable, Logger } from '@nestjs/common';
import { SystemConfigService } from '../config/system-config.service';
import { MailSettingsService } from '../config/mail-settings.service';
import { OutboxService } from '../outbox/outbox.service';
import { MailTransportService } from './mail-transport.service';

export interface MailHandlerContext {
  payload: Record<string, unknown>;
  mail: MailTransportService;
}

/** Handler dựng + gửi mail cho MỘT topic. 5.2–5.6 đăng ký handler thật cho từng topic. */
export type MailHandler = (ctx: MailHandlerContext) => Promise<void>;

/**
 * Consumer thông báo (AD-11) — chạy ở process worker. Nhiệm vụ 5.1: HẠ TẦNG dispatch
 * topic→handler + baseline durable + at-least-once. Luật mail thật cho từng topic do 5.2–5.6
 * gắn qua register(). Thứ tự BẤT BIẾN: gửi THÀNH CÔNG rồi mới markProcessed — SMTP không
 * tham gia tx nên crash giữa gửi-và-mark chấp nhận 1 mail đúp hiếm, TUYỆT ĐỐI không nuốt mail.
 */
@Injectable()
export class NotificationsConsumer {
  private readonly logger = new Logger(NotificationsConsumer.name);
  private readonly handlers = new Map<string, MailHandler>();
  private baseline: Date | null = null;

  constructor(
    private readonly outbox: OutboxService,
    private readonly config: SystemConfigService,
    private readonly mail: MailTransportService,
    private readonly mailSettings: MailSettingsService,
  ) {}

  /** 5.2–5.6 gọi (OnModuleInit) để gắn luật mail cho topic của mình. */
  register(topic: string, handler: MailHandler): void {
    this.handlers.set(topic, handler);
  }

  /**
   * Ghi baseline MỘT LẦN, durable (AC2) — gọi lúc worker boot trước khi nhận job. Restart về
   * sau đọc lại baseline cũ, KHÔNG ghi đè. Mọi event outbox created_at < baseline (tồn đọng
   * build/test Epic 3–4) sẽ mark processed không gửi → không flood hộp thư Admin ngày go-live.
   */
  async ensureBaseline(): Promise<void> {
    this.baseline = await this.config.ensureMailConsumerBaseline();
    this.logger.log(`baseline consumer = ${this.baseline.toISOString()}`);
  }

  /**
   * Xử một event outbox theo id (payload chỉ ref → tự đọc lại từ DB). Idempotent: đã xử → bỏ
   * qua (markProcessed trả false ⇒ handler KHÔNG chạy lại). Trước baseline → mark, không gửi.
   */
  async handle(topic: string, id: string): Promise<void> {
    if (!this.baseline) await this.ensureBaseline();
    const ev = await this.outbox.loadForConsumer(id);
    if (!ev || ev.processedAt) return; // không tồn tại / đã xử → idempotent
    if (this.baseline && ev.createdAt.getTime() < this.baseline.getTime()) {
      await this.outbox.markProcessed(id);
      return;
    }
    const handler = this.handlers.get(topic);
    if (!handler) {
      // Topic chưa có luật mail (5.2–5.6 chưa gắn) → mark để không kẹt queue, không crash.
      this.logger.warn(`topic '${topic}' chưa có handler mail — bỏ qua`);
      await this.outbox.markProcessed(id);
      return;
    }
    // Cấu hình thông báo: admin tắt loại mail này → mark, không gửi (chốt chặn DUY NHẤT).
    if (!(await this.mailSettings.isEnabled(topic))) {
      await this.outbox.markProcessed(id);
      return;
    }
    await handler({ payload: ev.payload, mail: this.mail });
    await this.outbox.markProcessed(id);
  }
}
