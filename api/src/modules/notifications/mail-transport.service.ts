import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Bọc SMTP Gmail Workspace (NFR-3). Credential CHỈ đọc từ env (AD-13c) — không plaintext DB,
 * không log nội dung/PII (AD-13f). Gửi lỗi NÉM RA để job vào retry→DLQ (AD-11: chết-im-lặng
 * thành ngoại-lệ-nhìn-thấy). Transport khởi tạo lười, tái dùng qua các lần gửi.
 */
@Injectable()
export class MailTransportService {
  private readonly logger = new Logger(MailTransportService.name);
  private transporter: Transporter | null = null;

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;
    const host = process.env.SMTP_HOST;
    if (!host) {
      throw new Error(
        'SMTP_HOST chưa cấu hình — không gửi mail được (NFR-12).',
      );
    }
    this.transporter = createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    });
    return this.transporter;
  }

  async send(msg: MailMessage): Promise<void> {
    await this.getTransporter().sendMail({
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    // AD-13f: KHÔNG log recipient/nội dung — chỉ subject (không PII) để truy vết.
    this.logger.log(`mail gửi: "${msg.subject}"`);
  }
}
