import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createTransport, type Transporter } from 'nodemailer';
import {
  SmtpConfigService,
  type SmtpTransport,
} from '../config/smtp-config.service';

export interface MailMessage {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Bọc SMTP (Gmail Workspace, NFR-3). Cấu hình ưu tiên đọc từ DB (màn Cấu hình › Email — mật khẩu
 * mã hoá, AD-13c nới có kiểm soát); fallback env (SMTP_HOST…). KHÔNG log nội dung/PII (AD-13f).
 * Gửi lỗi NÉM RA để job vào retry→DLQ. Transport cache theo fingerprint cấu hình → tự rebuild khi
 * admin đổi cấu hình (worker là process riêng nên phải phát hiện đổi qua DB, không dựa cache tĩnh).
 */
@Injectable()
export class MailTransportService {
  private readonly logger = new Logger(MailTransportService.name);
  private transporter: Transporter | null = null;
  private fp = '';

  constructor(private readonly smtpConfig: SmtpConfigService) {}

  private envConfig(): SmtpTransport | null {
    const host = process.env.SMTP_HOST;
    if (!host) return null;
    return {
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER ?? '',
      pass: process.env.SMTP_PASS ?? '',
      from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? '',
    };
  }

  private async getTransport(): Promise<{ transporter: Transporter; from: string }> {
    const cfg = (await this.smtpConfig.getForTransport()) ?? this.envConfig();
    if (!cfg) {
      throw new Error(
        'SMTP chưa cấu hình — vào Cấu hình › Email để nhập, hoặc đặt SMTP_HOST (NFR-12).',
      );
    }
    const from = cfg.from || cfg.user;
    const fp = createHash('sha256')
      .update(`${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}|${cfg.from}|${cfg.pass}`)
      .digest('base64');
    if (this.transporter && fp === this.fp) return { transporter: this.transporter, from };
    this.transporter = createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user && cfg.pass ? { user: cfg.user, pass: cfg.pass } : undefined,
    });
    this.fp = fp;
    return { transporter: this.transporter, from };
  }

  async send(msg: MailMessage): Promise<void> {
    const { transporter, from } = await this.getTransport();
    await transporter.sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    // AD-13f: KHÔNG log recipient/nội dung — chỉ subject (không PII) để truy vết.
    this.logger.log(`mail gửi: "${msg.subject}"`);
  }
}
