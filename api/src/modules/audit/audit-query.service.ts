import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';

export interface AuditQuery {
  actor?: string;
  action?: string;
  objectType?: string;
  objectId?: string;
  /** Ngày VN YYYY-MM-DD (tùy chọn) — from inclusive, to inclusive (+1 ngày). */
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export interface AuditRow {
  id: string;
  actor: string;
  action: string;
  objectType: string | null;
  objectId: string | null;
  detail: unknown;
  createdAt: string;
}

/** Viewer audit log (6.2) — CHỈ đọc (AD-10 append-only); ranh giới ngày theo VN (nhất quán 6.1). */
@Injectable()
export class AuditQueryService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

  async listAudit(q: AuditQuery): Promise<{
    items: AuditRow[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const conds = [
      q.actor ? sql`actor ILIKE ${'%' + q.actor + '%'}` : null,
      q.action ? sql`action = ${q.action}` : null,
      q.objectType ? sql`object_type = ${q.objectType}` : null,
      q.objectId ? sql`object_id ILIKE ${'%' + q.objectId + '%'}` : null,
      // VN: from 00:00, to inclusive → < (to + 1 ngày) 00:00 giờ VN
      q.from
        ? sql`created_at >= (${q.from}::date AT TIME ZONE 'Asia/Ho_Chi_Minh')`
        : null,
      q.to
        ? sql`created_at < ((${q.to}::date + 1) AT TIME ZONE 'Asia/Ho_Chi_Minh')`
        : null,
    ].filter((c): c is NonNullable<typeof c> => c !== null);
    const where =
      conds.length > 0 ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;

    const offset = (q.page - 1) * q.pageSize;
    const [items, totalRows] = await Promise.all([
      this.db.execute<{
        id: string;
        actor: string;
        action: string;
        object_type: string | null;
        object_id: string | null;
        detail: unknown;
        created_at: string;
      }>(sql`
        SELECT id, actor, action, object_type, object_id, detail, created_at
        FROM audit_log
        ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ${q.pageSize} OFFSET ${offset}
      `),
      this.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM audit_log ${where}
      `),
    ]);
    return {
      items: items.rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        objectType: r.object_type,
        objectId: r.object_id,
        detail: r.detail,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      total: totalRows.rows[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /** Distinct action cho dropdown lọc (AC3). */
  async distinctActions(): Promise<string[]> {
    const rows = await this.db.execute<{ action: string }>(
      sql`SELECT DISTINCT action FROM audit_log ORDER BY action`,
    );
    return rows.rows.map((r) => r.action);
  }
}
