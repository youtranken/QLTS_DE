import { Inject, Injectable } from '@nestjs/common';
import { randomUUID, randomBytes } from 'node:crypto';
import { eq, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import type { PmhIdClaims } from '../users/users.service';
import { LOCAL_SA_SUB } from './local-sa-env';
import { sessionsTable } from './sessions.schema';

export interface SessionRecord {
  id: string;
  userSub: string;
  refreshToken: string | null;
  accessTokenExp: Date | null;
  claims: PmhIdClaims | null;
  csrfToken: string;
  idToken: string | null;
  lastSeenAt: Date;
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
    await this.gcOrphans();
    const record: SessionRecord = {
      id: randomUUID(),
      userSub: params.userSub,
      refreshToken: params.refreshToken,
      accessTokenExp: params.accessTokenExp,
      claims: params.claims,
      csrfToken: randomBytes(32).toString('hex'),
      idToken: params.idToken,
      lastSeenAt: new Date(),
    };
    await this.db.insert(sessionsTable).values(record);
    return record;
  }

  /**
   * Tạo phiên SA local (break-glass, story 10.1): không token/claims OIDC —
   * `user_sub='local:sa'`, refresh/claims/id_token = null, csrf sinh mới.
   */
  async createLocalSa(): Promise<SessionRecord> {
    await this.gcOrphans();
    const record: SessionRecord = {
      id: randomUUID(),
      userSub: LOCAL_SA_SUB,
      refreshToken: null,
      accessTokenExp: null,
      claims: null,
      csrfToken: randomBytes(32).toString('hex'),
      idToken: null,
      lastSeenAt: new Date(),
    };
    await this.db.insert(sessionsTable).values(record);
    return record;
  }

  /** Cập nhật last_seen_at (phiên SA local dùng cho TTL idle — SSO cập nhật lúc refresh). */
  async touchLastSeen(id: string): Promise<void> {
    await this.db
      .update(sessionsTable)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessionsTable.id, id));
  }

  /** GC opportunistic: dọn phiên mồ côi (user bỏ đi không logout) — chặn bảng phình vô hạn. */
  private async gcOrphans(): Promise<void> {
    await this.db
      .delete(sessionsTable)
      .where(lt(sessionsTable.lastSeenAt, sql`now() - interval '30 days'`));
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
      lastSeenAt: row.lastSeenAt,
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
