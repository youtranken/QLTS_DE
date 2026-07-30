import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { SystemConfigService } from '../config/system-config.service';
import { MailTransportService } from './mail-transport.service';
import { NotificationRecipientsService } from './notification-recipients.service';
import { NotificationsConsumer } from './notifications.consumer';

const appBase = () => process.env.APP_BASE_URL ?? 'http://localhost:8080';
const TODAY_VN = sql`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

/**
 * Mail digest EOL: gộp 1 mail đến nhóm Admin liệt kê MÁY đã đủ tuổi thọ (cần thanh lý). Handler
 * `eol_digest` (phát bởi EolDigestService theo tuần). Rỗng (đã thanh lý hết trong khe relay) → bỏ.
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
      code: string | null;
      type: string;
      start_date: string;
      age_years: number;
    }>(sql`
      SELECT a.code, a.type, a.start_date::text AS start_date,
             date_part('year', age(${TODAY_VN}, a.start_date))::int AS age_years
      FROM assets a
      WHERE a.type <> 'software' AND a.status <> 'disposed' AND a.purged_at IS NULL
        AND a.start_date IS NOT NULL
        AND a.start_date <= (${TODAY_VN} - make_interval(years => ${lifespanYears}::int))::date
      ORDER BY a.start_date
    `);
    if (rows.rows.length === 0) return; // đã thanh lý hết → không mail rỗng
    const to = await this.recipients.adminEmails();
    if (to.length === 0) {
      this.logger.warn('không có admin email — bỏ qua digest EOL');
      return;
    }
    const lines = rows.rows
      .map((r) => `- ${r.code ?? '?'} (${r.type}): đã dùng ${r.age_years} năm, từ ${r.start_date}`)
      .join('\n');
    await mail.send({
      to,
      subject: `QLTS: ${rows.rows.length} máy đủ tuổi thọ (≥${lifespanYears} năm) — cần thanh lý`,
      text: `Các máy đã đủ tuổi thọ, nên xem xét thanh lý:\n${lines}\nXem: ${appBase()}/eol`,
    });
  }
}
