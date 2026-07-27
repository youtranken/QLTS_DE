import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { allocationHistoryTable } from './allocation-history.schema';
import { assetNoteTable } from './asset-note.schema';
import { assetsTable } from './assets.schema';
import { mapAssetPgError } from './asset-pg-error';

/** Row đã FOR UPDATE cho thao tác vòng đời (2.6). */
interface LifecycleRow {
  type: string;
  status: string;
  isPool: boolean;
  version: number;
  assignedUserSub: string | null;
}

export type LifecycleTx = Pick<
  Database,
  'update' | 'insert' | 'execute' | 'select'
>;

/**
 * Vòng đời tài sản (2.6): khóa/mở/thanh lý/tái sử dụng/bật-tắt pool + biến thể *Within
 * (Tickets cascade gọi trong CÙNG tx — AD-1) + runLifecycleWithin orchestrator + *Spec
 * builders + autoUnlockExpiredLocks + detachAllFrom. Tách khỏi AssetsService (mục 6);
 * facade delegate giữ public API cho controller + TicketsLifecycleService.
 */
@Injectable()
export class AssetsLifecycleService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly audit: AuditWriterService,
  ) {}

  async detachAllFrom(
    tx: Pick<Database, 'execute' | 'insert'>,
    machineId: string,
    actorSub: string,
  ): Promise<string[]> {
    const result = await tx.execute<{ code: string }>(sql`
      UPDATE assets
      SET installed_on_asset_id = NULL, version = version + 1, updated_at = now()
      WHERE installed_on_asset_id = ${machineId}
      RETURNING code
    `);
    const codes = result.rows.map((r) => r.code);
    if (codes.length > 0) {
      await this.audit.appendWithin(tx, {
        actor: actorSub,
        action: 'assets.license_detach_all',
        objectType: 'asset',
        objectId: machineId,
        detail: { detached: codes },
      });
    }
    return codes;
  }

  async lock(
    id: string,
    reason: string,
    eta: string | null,
    version: number,
    actorSub: string,
  ) {
    return this.lifecycle(
      id,
      version,
      actorSub,
      this.lockSpec(id, reason, eta, actorSub),
    );
  }

  /** Mở khóa (2.6): locked_repair → in_use; pool tự "như trước" vì không bao giờ bị đụng. */
  async unlock(id: string, version: number, actorSub: string) {
    return this.lifecycle(id, version, actorSub, this.unlockSpec(id, actorSub));
  }

  async dispose(id: string, version: number, actorSub: string) {
    return this.lifecycle(
      id,
      version,
      actorSub,
      this.disposeSpec(id, actorSub),
    );
  }

  async reactivate(
    id: string,
    version: number,
    actorSub: string,
    newCode: string | null,
  ) {
    return this.lifecycle(
      id,
      version,
      actorSub,
      this.reactivateSpec(id, newCode),
    );
  }

  /** Bật/gỡ pool (2.6, FR-31/33): CHỈ cờ đổi, status giữ nguyên; software/disposed chặn. */
  async setPool(
    id: string,
    isPool: boolean,
    version: number,
    actorSub: string,
  ) {
    return this.lifecycle(id, version, actorSub, this.setPoolSpec(id, isPool));
  }

  private async lifecycle(
    id: string,
    version: number,
    actorSub: string,
    spec: {
      action: string;
      guard: (
        row: LifecycleRow,
      ) => 'NOT_MACHINE' | 'INVALID_STATE' | 'NOT_POOL' | null;
      apply: (
        tx: LifecycleTx,
        row: LifecycleRow,
      ) => Promise<Record<string, unknown> | null>;
    },
  ) {
    try {
      return await this.db.transaction((tx) =>
        this.runLifecycleWithin(tx, id, version, actorSub, spec),
      );
    } catch (error) {
      throw mapAssetPgError(error);
    }
  }

  async runLifecycleWithin(
    tx: LifecycleTx,
    id: string,
    version: number,
    actorSub: string,
    spec: {
      action: string;
      guard: (
        row: LifecycleRow,
      ) => 'NOT_MACHINE' | 'INVALID_STATE' | 'NOT_POOL' | null;
      apply: (
        tx: LifecycleTx,
        row: LifecycleRow,
      ) => Promise<Record<string, unknown> | null>;
    },
  ) {
    const rows = await tx
      .select({
        type: assetsTable.type,
        status: assetsTable.status,
        isPool: assetsTable.isPool,
        version: assetsTable.version,
        assignedUserSub: assetsTable.assignedUserSub,
      })
      .from(assetsTable)
      .where(eq(assetsTable.id, id))
      .for('update');
    const row = rows[0];
    if (!row) {
      throw new NotFoundException({
        code: 'ASSET_NOT_FOUND',
        message: 'Không tìm thấy tài sản này.',
      });
    }
    if (row.version !== version) {
      throw new ConflictException({
        code: 'STALE_VERSION',
        message: 'Trạng thái đã thay đổi, tải lại.',
      });
    }
    const violation = spec.guard(row);
    if (violation === 'NOT_MACHINE') {
      throw new BadRequestException({
        code: 'NOT_MACHINE',
        message: 'Thao tác này chỉ áp dụng cho máy, không áp dụng phần mềm.',
      });
    }
    if (violation === 'INVALID_STATE') {
      throw new ConflictException({
        code: 'INVALID_STATE',
        message: `Trạng thái hiện tại (${row.status}) không cho phép thao tác này.`,
      });
    }
    if (violation === 'NOT_POOL') {
      throw new ConflictException({
        code: 'NOT_POOL',
        message: 'Chỉ khóa sửa chữa được máy trong pool cho mượn.',
      });
    }
    const detail = await spec.apply(tx, row);
    if (detail === null) {
      return { ok: true, version: row.version };
    }
    await this.audit.appendWithin(tx, {
      actor: actorSub,
      action: spec.action,
      objectType: 'asset',
      objectId: id,
      detail: { from_status: row.status, ...detail },
    });
    return { ok: true, version: row.version + 1 };
  }

  /** Spec builders (3.10) — dùng chung cho lifecycle() 2.6 lẫn *Within orchestrator. */
  private lockSpec(
    id: string,
    reason: string,
    eta: string | null,
    actorSub: string,
  ) {
    return {
      action: 'assets.lock',
      guard: (row: LifecycleRow) => {
        if (row.type === 'software') return 'NOT_MACHINE' as const;
        if (row.status !== 'in_use') return 'INVALID_STATE' as const;
        // Khóa sửa chữa CHỈ cho máy pool (yêu cầu UAT): máy ngoài pool không đi luồng khóa.
        if (!row.isPool) return 'NOT_POOL' as const;
        return null;
      },
      apply: async (tx: LifecycleTx, row: LifecycleRow) => {
        await tx
          .update(assetsTable)
          .set({
            status: 'locked_repair',
            // lock_eta = ETA → sweep auto-unlock khi tới ngày (0036).
            lockEta: eta,
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(assetsTable.id, id));
        await tx.insert(assetNoteTable).values({
          assetId: id,
          kind: 'lock',
          note: reason,
          eta,
          actor: actorSub,
        });
        return { reason, eta };
      },
    };
  }

  private disposeSpec(id: string, actorSub: string) {
    return {
      action: 'assets.dispose',
      guard: (row: LifecycleRow) =>
        row.status === 'disposed' ? ('INVALID_STATE' as const) : null,
      apply: async (tx: LifecycleTx, row: LifecycleRow) => {
        // Thanh lý máy → gỡ người đứng tên: máy đã bỏ không còn ai "đang giữ".
        // Nếu KHÔNG gỡ, offboarding-scan (đếm theo assigned_user_sub) sẽ báo phantom
        // vĩnh viễn cho nhân viên nghỉ việc từng giữ máy này (audit 2026-07-16 H1).
        const clearHolder =
          row.type !== 'software' && row.assignedUserSub != null;
        await tx
          .update(assetsTable)
          .set({
            status: 'disposed',
            isPool: false,
            lockEta: null, // thanh lý → xóa ETA khóa còn sót (dữ liệu sạch)
            version: row.version + 1,
            updatedAt: new Date(),
            ...(row.type === 'software'
              ? { installedOnAssetId: null }
              : { assignedUserSub: null }),
          })
          .where(eq(assetsTable.id, id));
        // Giữ allocation_history đầy đủ (AD-10 append-only): ghi vết trả về from→null.
        if (clearHolder) {
          await tx.insert(allocationHistoryTable).values({
            assetId: id,
            fromUserSub: row.assignedUserSub,
            toUserSub: null,
            note: null,
            actor: actorSub,
          });
        }
        let detached: string[] = [];
        if (row.type !== 'software') {
          detached = await this.detachAllFrom(tx, id, actorSub);
        }
        await tx.insert(assetNoteTable).values({
          assetId: id,
          kind: 'dispose',
          note: null,
          eta: null,
          actor: actorSub,
        });
        return {
          detached,
          pool_cleared: row.isPool,
          holder_cleared: clearHolder ? row.assignedUserSub : null,
        };
      },
    };
  }

  private reactivateSpec(id: string, newCode: string | null) {
    return {
      action: 'assets.reactivate',
      guard: (row: LifecycleRow) =>
        row.status !== 'disposed' ? ('INVALID_STATE' as const) : null,
      apply: async (tx: LifecycleTx, row: LifecycleRow) => {
        await tx
          .update(assetsTable)
          .set({
            status: 'in_use',
            lockEta: null,
            ...(newCode ? { code: newCode } : {}),
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(assetsTable.id, id));
        return { to_status: 'in_use', ...(newCode ? { new_code: newCode } : {}) };
      },
    };
  }

  private setPoolSpec(id: string, isPool: boolean) {
    return {
      action: 'assets.pool_change',
      guard: (row: LifecycleRow) => {
        if (row.type === 'software') return 'NOT_MACHINE' as const;
        if (row.status === 'disposed') return 'INVALID_STATE' as const;
        return null;
      },
      apply: async (tx: LifecycleTx, row: LifecycleRow) => {
        if (row.isPool === isPool) return null;
        await tx
          .update(assetsTable)
          .set({ isPool, version: row.version + 1, updatedAt: new Date() })
          .where(eq(assetsTable.id, id));
        return { from: row.isPool, to: isPool };
      },
    };
  }

  private unlockSpec(id: string, actorSub: string) {
    return {
      action: 'assets.unlock',
      guard: (row: LifecycleRow) => {
        if (row.type === 'software') return 'NOT_MACHINE' as const;
        if (row.status !== 'locked_repair') return 'INVALID_STATE' as const;
        return null;
      },
      apply: async (tx: LifecycleTx, row: LifecycleRow) => {
        await tx
          .update(assetsTable)
          .set({
            status: 'in_use',
            lockEta: null, // mở khóa → xóa ETA (sweep không đụng nữa)
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(assetsTable.id, id));
        await tx.insert(assetNoteTable).values({
          assetId: id,
          kind: 'unlock',
          note: null,
          eta: null,
          actor: actorSub,
        });
        return {};
      },
    };
  }

  /** *Within (3.10): orchestrator Tickets gọi trong tx của mình (cascade cùng transaction). */
  lockWithin(
    tx: LifecycleTx,
    id: string,
    reason: string,
    eta: string | null,
    version: number,
    actorSub: string,
  ) {
    return this.runLifecycleWithin(
      tx,
      id,
      version,
      actorSub,
      this.lockSpec(id, reason, eta, actorSub),
    );
  }

  unlockWithin(tx: LifecycleTx, id: string, version: number, actorSub: string) {
    return this.runLifecycleWithin(
      tx,
      id,
      version,
      actorSub,
      this.unlockSpec(id, actorSub),
    );
  }

  disposeWithin(
    tx: LifecycleTx,
    id: string,
    version: number,
    actorSub: string,
  ) {
    return this.runLifecycleWithin(
      tx,
      id,
      version,
      actorSub,
      this.disposeSpec(id, actorSub),
    );
  }

  setPoolWithin(
    tx: LifecycleTx,
    id: string,
    isPool: boolean,
    version: number,
    actorSub: string,
  ) {
    return this.runLifecycleWithin(
      tx,
      id,
      version,
      actorSub,
      this.setPoolSpec(id, isPool),
    );
  }

  async autoUnlockExpiredLocks(): Promise<number> {
    return this.db.transaction(async (tx) => {
      // KHÔNG lọc is_pool: máy đã khóa vốn TỪNG là pool (guard lock chỉ cho pool); nếu sau
      // đó bị gỡ pool lúc đang khóa vẫn phải tự mở khi tới ETA (tránh kẹt khóa vĩnh viễn).
      const unlocked = await tx.execute<{ id: string }>(sql`
        UPDATE assets
        SET status = 'in_use', lock_eta = NULL, version = version + 1, updated_at = now()
        WHERE status = 'locked_repair'
          AND lock_eta IS NOT NULL
          AND lock_eta <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        RETURNING id
      `);
      for (const r of unlocked.rows) {
        await tx.insert(assetNoteTable).values({
          assetId: r.id,
          kind: 'unlock',
          note: 'Tự mở khóa: đã tới ngày dự kiến (ETA).',
          eta: null,
          actor: 'system',
        });
        await this.audit.appendWithin(tx, {
          actor: 'system',
          action: 'assets.auto_unlock',
          objectType: 'asset',
          objectId: r.id,
          detail: {},
        });
      }
      return unlocked.rows.length;
    });
  }
}
