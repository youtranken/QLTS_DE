import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { SystemConfigService } from '../config/system-config.service';
import { MailTransportService } from './mail-transport.service';
import { NotificationRecipientsService } from './notification-recipients.service';
import { NotificationsConsumer } from './notifications.consumer';
import { renderMail } from './mail-layout';

const appBase = () => process.env.APP_BASE_URL ?? 'http://localhost:8080';
const TODAY_VN = sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

/**
 * Mail digest EOL: gộp 1 mail đến nhóm Admin liệt kê MÁY MỚI đủ tuổi thọ (cần thanh lý). Handler
 * `eol_digest` (phát bởi EolDigestService theo tuần). Chỉ máy chưa từng báo (eol_notified_at NULL);
 * đánh dấu các máy đó ngay sau khi gửi để tuần sau không nhắc lại. Rỗng (thanh lý hết trong khe
 * relay) → bỏ.
 */
@Injectable()
export class EolDigestMailRegistrar implements OnModuleInit {
  private readonly logger = new Logger(EolDigestMailRegistrar.name);

  constructor(
    private readonly consumer: NotificationsConsumer,
    private readonly recipients: NotificationRecipientsService,
    private readonly config: SystemConfigService,
    @Inject(DRIZZLE_DB) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.consumer.register('eol_digest', (ctx) => this.send(ctx.mail));
  }

  private async send(mail: MailTransportService): Promise<void> {
    const lifespanYears = await this.config.getAssetLifespanYears();
    const rows = await this.db.execute<{
      id: string;
      code: string | null;
      type: string;
      start_date: string;
      age_years: number;
    }>(sql`
      SELECT a.id, a.code, a.type, a.start_date::text AS start_date,
             date_part('year', age(${TODAY_VN}, a.start_date))::int AS age_years
      FROM assets a
      WHERE a.type <> 'software' AND a.status <> 'disposed' AND a.purged_at IS NULL
        AND a.eol_notified_at IS NULL
        AND a.start_date IS NOT NULL
        AND a.start_date <= (${TODAY_VN} - make_interval(years => ${lifespanYears}::int))::date
      ORDER BY a.start_date
    `);
    if (rows.rows.length === 0) return; // không máy mới (đã báo/đã thanh lý hết) → không mail rỗng
    const to = await this.recipients.adminEmails();
    if (to.length === 0) {
      this.logger.warn('không có admin email — bỏ qua digest EOL');
      return;
    }
    const list = rows.rows.map(
      (r) =>
        `${r.code ?? '?'} (${r.type}): đã dùng ${r.age_years} năm, từ ${r.start_date}`,
    );
    const n = rows.rows.length;
    const { html, text } = renderMail({
      title: `${n} máy mới đủ tuổi thọ — cần thanh lý`,
      tone: 'warn',
      preheader: `${n} máy ≥ ${lifespanYears} năm`,
      intro: `Các máy sau vừa đủ tuổi thọ (≥ ${lifespanYears} năm) và lần đầu được báo, nên xem xét thanh lý:`,
      list,
      cta: { label: 'Xem danh sách EOL', url: `${appBase()}/eol` },
    });
    await mail.send({
      to,
      subject: `QLTS: ${n} máy mới đủ tuổi thọ (≥${lifespanYears} năm) — cần thanh lý`,
      text,
      html,
    });
    // Đánh dấu ĐÃ báo (chỉ các máy vừa gửi) → tuần sau không nhắc lại tới khi thanh lý.
    const ids = rows.rows.map((r) => r.id);
    await this.db.execute(sql`
      UPDATE assets SET eol_notified_at = now()
      WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        AND eol_notified_at IS NULL
    `);
  }
}
