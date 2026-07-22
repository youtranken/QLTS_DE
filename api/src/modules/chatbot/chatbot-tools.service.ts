import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AssetsService } from '../assets/assets.service';
import { BookingService } from '../booking/booking.service';
import type { AssetCard, AssetFilter, Identity } from './chatbot.types';

/** Trần dòng đổ vào một bong bóng (G4) — kèm "hiển thị N/tổng M". */
export const RESULT_CAP = 8;

/**
 * Lớp tool dùng chung cho guided + Gemini. Bọc service ĐÃ CÓ; QUYỀN enforce Ở ĐÂY
 * theo `identity.role` — Gemini chỉ chọn tool + args, KHÔNG quyết quyền (chống leo thang).
 */
@Injectable()
export class ChatbotToolsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly assets: AssetsService,
    private readonly booking: BookingService,
  ) {}

  /** Danh sách tài sản: admin/sa = toàn sổ; member = CHỈ máy mình (self-scoped, G2). */
  async searchAssets(
    identity: Identity,
    filter: AssetFilter,
  ): Promise<{ cards: AssetCard[]; total: number }> {
    if (identity.role === 'admin' || identity.role === 'sa') {
      const res = await this.assets.list({
        page: 1,
        pageSize: RESULT_CAP,
        type: filter.type,
        status: filter.status,
        endFrom: filter.endFrom,
        endTo: filter.endTo,
        search: filter.search,
        excludeSoftware: true,
      });
      return {
        cards: res.items.map((i) => ({
          code: i.code,
          type: i.type,
          holder: i.assignedUserName ?? null,
          status: i.status,
          endDate: i.endDate,
          // Admin tra cứu mã cụ thể → kèm phần mềm đang cài trên máy (installedSoftware sẵn có).
          software: i.installedSoftware ?? null,
        })),
        total: res.total,
      };
    }
    return this.selfAssets(identity.sub, filter);
  }

  /** "Máy của tôi" — self-scoped cho mọi vai (admin cũng xem máy mình giữ). */
  myAssets(sub: string): Promise<{ cards: AssetCard[]; total: number }> {
    return this.selfAssets(sub, {});
  }

  /** Máy pool còn trống trong [from,to] (read-model AD-5, không lộ người mượn). */
  async checkAvailability(
    from: string,
    to: string,
    type?: string,
  ): Promise<{ cards: AssetCard[]; total: number }> {
    const machines = await this.booking.availableMachines(
      from,
      to,
      type ?? null,
    );
    return {
      cards: machines.slice(0, RESULT_CAP).map((m) => ({
        code: m.code,
        type: m.type,
        holder: null,
        status: 'Trống',
        endDate: null,
      })),
      total: machines.length,
    };
  }

  /** Distinct loại máy pool — chip lọc loại. */
  assetTypes(): Promise<string[]> {
    return this.booking.assetTypes();
  }

  /**
   * Máy của một sub — G2: query riêng có `end_date`/`status` để member cũng lọc
   * theo ngày/trạng thái (getMyAssets không trả end_date). Self-scoped tuyệt đối.
   */
  private async selfAssets(
    sub: string,
    filter: AssetFilter,
  ): Promise<{ cards: AssetCard[]; total: number }> {
    const where = sql`assigned_user_sub = ${sub} AND type <> 'software' AND status <> 'disposed' AND purged_at IS NULL${
      filter.type ? sql` AND type = ${filter.type}` : sql``
    }${filter.status ? sql` AND status = ${filter.status}` : sql``}${
      filter.endFrom ? sql` AND end_date >= ${filter.endFrom}` : sql``
    }${filter.endTo ? sql` AND end_date <= ${filter.endTo}` : sql``}${
      filter.search
        ? sql` AND (code ILIKE ${`%${filter.search}%`} OR configuration ILIKE ${`%${filter.search}%`} OR brand ILIKE ${`%${filter.search}%`})`
        : sql``
    }`;
    const rows = await this.db.execute<{
      code: string | null;
      type: string;
      status: string;
      end_date: string | null;
    }>(sql`
      SELECT code, type, status, end_date
      FROM assets
      WHERE ${where}
      ORDER BY code
      LIMIT ${RESULT_CAP}
    `);
    const totalRes = await this.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM assets WHERE ${where}`,
    );
    return {
      cards: rows.rows.map((r) => ({
        code: r.code,
        type: r.type,
        holder: null,
        status: r.status,
        endDate: r.end_date,
      })),
      total: totalRes.rows[0]?.n ?? 0,
    };
  }
}
