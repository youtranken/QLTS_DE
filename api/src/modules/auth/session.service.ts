import { Inject, Injectable } from '@nestjs/common';
import { randomUUID, randomBytes } from 'node:crypto';
import { eq, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import type { PmhIdClaims } from '../users/users.service';
import { sessionsTable } from './sessions.schema';

export interface SessionRecord {
  id: string;
  userSub: string;
  refreshToken: string | null;
  accessTokenExp: Date | null;
  claims: PmhIdClaims | null;
  csrfToken: string;
  idToken: string | null;
}

@Injectable()
export class SessionService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

  async create(params: {
    userSub: string;
    refreshToken: string | null;
    accessTokenExp: Date | null;
    claims: PmhIdClaims;
    idToken: string | null;
  }): Promise<SessionRecord> {
    // GC opportunistic: dọn phiên mồ côi (user bỏ đi không logout) — chặn bảng phình vô hạn
    await this.db
      .delete(sessionsTable)
      .where(lt(sessionsTable.lastSeenAt, sql`now() - interval '30 days'`));
    const record = {
      id: randomUUID(),
      userSub: params.userSub,
      refreshToken: params.refreshToken,
      accessTokenExp: params.accessTokenExp,
      claims: params.claims,
      csrfToken: randomBytes(32).toString('hex'),
      idToken: params.idToken,
    };
    await this.db.insert(sessionsTable).values(record);
    return record;
  }

  async find(id: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, id));
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      userSub: row.userSub,
      refreshToken: row.refreshToken,
      accessTokenExp: row.accessTokenExp,
      claims: row.claims as PmhIdClaims | null,
      csrfToken: row.csrfToken,
      idToken: row.idToken,
    };
  }

  /** Sau khi refresh thành công: token + claims mới. Trả false nếu phiên đã bị xóa (webhook đá giữa chừng). */
  async updateTokens(
    id: string,
    params: {
      refreshToken: string | null;
      accessTokenExp: Date | null;
      claims: PmhIdClaims;
      idToken: string | null;
    },
  ): Promise<boolean> {
    const rows = await this.db
      .update(sessionsTable)
      .set({
        refreshToken: params.refreshToken,
        accessTokenExp: params.accessTokenExp,
        claims: params.claims,
        idToken: params.idToken,
        lastSeenAt: new Date(),
      })
      .where(eq(sessionsTable.id, id))
      .returning({ id: sessionsTable.id });
    return rows.length > 0;
  }

  async destroy(id: string): Promise<void> {
    await this.db.delete(sessionsTable).where(eq(sessionsTable.id, id));
  }

  /** Webhook đá phiên tức thì (NFR-11): hủy MỌI phiên của user. */
  async destroyAllForUser(userSub: string): Promise<number> {
    const rows = await this.db
      .delete(sessionsTable)
      .where(eq(sessionsTable.userSub, userSub))
      .returning({ id: sessionsTable.id });
    return rows.length;
  }
}
