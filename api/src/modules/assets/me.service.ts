import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';

/**
 * UP-5.2: dữ liệu hồ sơ "của tôi" — member self-scoped theo req.user.sub. Tách khỏi
 * AssetsService/@Roles(sa,admin) vì member phải xem được tài sản mình đang giữ mà KHÔNG
 * chạm sổ tài sản admin. Chỉ đọc, giới hạn theo sub — không nhận id ngoài để tránh IDOR.
 */
@Injectable()
export class MeService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

  async getMyAssets(sub: string) {
    const devices = await this.db.execute<{
      id: string;
      code: string | null;
      type: string;
      configuration: string | null;
      brand: string | null;
      model: string | null;
      status: string;
      start_date: string | null;
    }>(sql`
      SELECT id, code, type, configuration, brand, model, status, start_date
      FROM assets
      WHERE assigned_user_sub = ${sub}
        AND type <> 'software'
        AND status <> 'disposed'
        AND purged_at IS NULL
      ORDER BY code
    `);

    // Phần mềm derive theo máy mình giữ (sw-license-model): holder = người giữ máy chủ.
    const software = await this.db.execute<{
      id: string;
      name: string | null;
      license_type: string | null;
      end_date: string | null;
      status: string;
      host_code: string | null;
    }>(sql`
      SELECT s.id, s.license_name AS name, s.license_type, s.end_date,
             s.status, host.code AS host_code
      FROM assets s
      JOIN assets host ON s.installed_on_asset_id = host.id
      WHERE s.type = 'software'
        AND host.assigned_user_sub = ${sub}
        AND s.status <> 'disposed'
        AND s.purged_at IS NULL
      ORDER BY s.license_name
    `);

    const history = await this.db.execute<{
      id: string;
      from_user_sub: string | null;
      to_user_sub: string | null;
      from_name: string | null;
      to_name: string | null;
      actor_name: string | null;
      note: string | null;
      asset_code: string | null;
      asset_type: string;
      created_at: Date;
    }>(sql`
      SELECT h.id, h.from_user_sub, h.to_user_sub, h.note, h.created_at,
             a.code AS asset_code, a.type AS asset_type,
             fu.full_name AS from_name, tu.full_name AS to_name, au.full_name AS actor_name
      FROM allocation_history h
      JOIN assets a ON a.id = h.asset_id
      LEFT JOIN users fu ON fu.sub = h.from_user_sub
      LEFT JOIN users tu ON tu.sub = h.to_user_sub
      LEFT JOIN users au ON au.sub = h.actor
      WHERE h.to_user_sub = ${sub} OR h.from_user_sub = ${sub}
      ORDER BY h.created_at DESC
      LIMIT 50
    `);

    return {
      devices: devices.rows,
      software: software.rows,
      history: history.rows,
    };
  }
}
