import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { expiringLicenseWhere } from '../../common/license-expiry';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { SystemConfigService } from '../config/system-config.service';
import { MailTransportService } from './mail-transport.service';
import { NotificationRecipientsService } from './notification-recipients.service';
import { NotificationsConsumer } from './notifications.consumer';
import { renderMail } from './mail-layout';

interface ExpiringLicense {
  name: string;
  hostCode: string | null;
  endDate: string;
}

const appBase = () => process.env.APP_BASE_URL ?? 'http://localhost:8080';

/**
 * Mail digest license sắp hết hạn (5.6, FR-29, AD-11). Handler `license_digest`: query lại danh
 * sách license đang cảnh báo (điều kiện dùng chung 2.5), gộp 1 mail đến nhóm Admin. Rỗng (đã gia
 * hạn hết trong khe relay) → bỏ qua.
 */
@Injectable()
export class LicenseDigestMailRegistrar implements OnModuleInit {
  private readonly logger = new Logger(LicenseDigestMailRegistrar.name);

  constructor(
    private readonly consumer: NotificationsConsumer,
    private readonly recipients: NotificationRecipientsService,
    private readonly config: SystemConfigService,
    @Inject(DRIZZLE_DB) private readonly db: Database,
  ) {}

  onModuleInit(): void {
    this.consumer.register('license_digest', (ctx) => this.send(ctx.mail));
  }

  private async send(mail: MailTransportService): Promise<void> {
    const warningDays = await this.config.getLicenseWarningDays();
    const rows = await this.db.execute<{
      name: string;
      host_code: string | null;
      end_date: string;
    }>(sql`
      SELECT COALESCE(a.license_name, a.code) AS name,
             h.code AS host_code,
             a.end_date::text AS end_date
      FROM assets a
      LEFT JOIN assets h ON h.id = a.installed_on_asset_id
      WHERE ${expiringLicenseWhere(warningDays)}
      ORDER BY a.end_date
    `);
    if (rows.rows.length === 0) return; // đã gia hạn hết → không mail rỗng
    const to = await this.recipients.adminEmails();
    if (to.length === 0) {
      this.logger.warn('không có admin email — bỏ qua digest license');
      return;
    }
    const items: ExpiringLicense[] = rows.rows.map((r) => ({
      name: r.name,
      hostCode: r.host_code,
      endDate: r.end_date,
    }));
    const list = items.map(
      (i) => `${i.name} (máy ${i.hostCode ?? '?'}): hết hạn ${i.endDate}`,
    );
    const { html, text } = renderMail({
      title: `${items.length} license sắp/đã hết hạn`,
      tone: 'warn',
      preheader: `${items.length} license cần gia hạn`,
      intro: 'Các license sau cần được gia hạn:',
      list,
      cta: { label: 'Xem tài sản', url: `${appBase()}/assets` },
    });
    await mail.send({
      to,
      subject: `QLTS: ${items.length} license sắp/đã hết hạn`,
      text,
      html,
    });
  }
}
