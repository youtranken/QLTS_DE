import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';

/**
 * Người nhận mail nghiệp vụ (5.2). "Nhóm Admin" = users `role='admin'`, `status='active'`, có
 * email. SA là tài khoản local (không có trong bảng users, story 10.1) → không phải recipient
 * nghiệp vụ mặc định (mail vận hành đi tới nhóm Admin SSO).
 */
@Injectable()
export class NotificationRecipientsService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

  async adminEmails(): Promise<string[]> {
    const r = await this.db.execute<{ email: string }>(sql`
      SELECT email FROM users
      WHERE role = 'admin' AND status = 'active'
        AND email IS NOT NULL AND email <> ''
    `);
    return r.rows.map((row) => row.email);
  }
}
