import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { assetsTable } from '../assets/assets.schema';
import { usersTable } from '../users/users.schema';
import { TicketsService } from '../tickets/tickets.service';

export interface PoolItem {
  id: string;
  // code nullable ở schema (phần mềm không mã); pool CHỈ máy nên thực tế luôn có mã.
  code: string | null;
  type: string;
  configuration: string | null;
  brand: string | null;
  status: string;
  version: number;
  assignedUserName: string | null;
}

/**
 * Pool máy cho mượn (8.3): read danh sách máy is_pool + thêm máy vào pool bằng MTS.
 * GHI is_pool đi qua TicketsService.setPoolCascade (Tickets sở hữu state pool + cascade AD-1) —
 * KHÔNG tự UPDATE is_pool ở đây. Gỡ khỏi pool: FE gọi PUT /admin/assets/:id/pool (cascade sẵn có).
 */
@Injectable()
export class PoolService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly tickets: TicketsService,
  ) {}

  /** Máy đang cho mượn (is_pool=true) + thông tin kéo từ QLTS. */
  async list(): Promise<PoolItem[]> {
    return this.db
      .select({
        id: assetsTable.id,
        code: assetsTable.code,
        type: assetsTable.type,
        configuration: assetsTable.configuration,
        brand: assetsTable.brand,
        status: assetsTable.status,
        version: assetsTable.version,
        assignedUserName: usersTable.fullName,
      })
      .from(assetsTable)
      .leftJoin(usersTable, eq(assetsTable.assignedUserSub, usersTable.sub))
      .where(eq(assetsTable.isPool, true))
      .orderBy(asc(assetsTable.code));
  }

  /**
   * Thêm máy vào pool bằng MTS (mã tài sản). Chỉ cần nhập mã — thông tin lấy từ QLTS.
   * Điều kiện: máy tồn tại, KHÔNG phải software, đang dùng (in_use). Idempotent nếu đã trong pool.
   */
  async addByCode(code: string, actorSub: string): Promise<PoolItem> {
    const c = code.trim();
    if (!c) {
      throw new BadRequestException({
        code: 'POOL_CODE_EMPTY',
        message: 'Nhập mã tài sản (MTS).',
      });
    }
    const found = await this.db
      .select({
        id: assetsTable.id,
        type: assetsTable.type,
        status: assetsTable.status,
        isPool: assetsTable.isPool,
        version: assetsTable.version,
      })
      .from(assetsTable)
      .where(sql`lower(${assetsTable.code}) = lower(${c})`);
    const asset = found[0];
    if (!asset) {
      throw new NotFoundException({
        code: 'POOL_ASSET_NOT_FOUND',
        message: `Không tìm thấy tài sản mã "${c}".`,
      });
    }
    if (asset.type === 'software') {
      throw new BadRequestException({
        code: 'POOL_ASSET_SOFTWARE',
        message:
          'Phần mềm không cho mượn như máy — chỉ thêm thiết bị vào pool.',
      });
    }
    if (asset.status !== 'in_use') {
      throw new BadRequestException({
        code: 'POOL_ASSET_NOT_IN_USE',
        message:
          'Chỉ thêm máy đang dùng vào pool (máy khóa sửa/thanh lý không cho mượn).',
      });
    }
    if (asset.isPool) {
      // Đã trong pool → trả về row hiện tại, không lỗi (idempotent).
      return this.getPoolItem(asset.id);
    }
    // Bật pool qua orchestrator Tickets (isPool=true → không cascade).
    await this.tickets.setPoolCascade(
      asset.id,
      true,
      asset.version,
      actorSub,
      true,
    );
    return this.getPoolItem(asset.id);
  }

  private async getPoolItem(id: string): Promise<PoolItem> {
    const rows = await this.db
      .select({
        id: assetsTable.id,
        code: assetsTable.code,
        type: assetsTable.type,
        configuration: assetsTable.configuration,
        brand: assetsTable.brand,
        status: assetsTable.status,
        version: assetsTable.version,
        assignedUserName: usersTable.fullName,
      })
      .from(assetsTable)
      .leftJoin(usersTable, eq(assetsTable.assignedUserSub, usersTable.sub))
      .where(and(eq(assetsTable.id, id)));
    return rows[0];
  }
}
