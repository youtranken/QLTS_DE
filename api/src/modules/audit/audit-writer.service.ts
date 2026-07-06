import { Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { auditLogTable } from './audit.schema';

export interface AuditEntry {
  /** user `sub` hoặc 'system' */
  actor: string;
  action: string;
  objectType?: string;
  objectId?: string;
  detail?: Record<string, unknown>;
}

/**
 * Writer audit tối giản (story 1.2) — CHỈ INSERT (AD-10).
 * Story 1.4 xây interceptor declarative TRÊN writer này, không thay thế.
 */
@Injectable()
export class AuditWriterService {
  private readonly logger = new Logger(AuditWriterService.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

  async append(entry: AuditEntry): Promise<void> {
    try {
      await this.db.insert(auditLogTable).values(toRow(entry));
    } catch (error) {
      // Ghi audit lỗi không được làm gãy nghiệp vụ auth — log để giám sát
      this.logger.error(
        `Ghi audit thất bại (${entry.action}): ${(error as Error).message}`,
      );
    }
  }

  /**
   * Ghi audit TRONG transaction nghiệp vụ (review 2.1) — lỗi NÉM RA để rollback
   * cả mutation: với sổ tài sản, "đổi được nhưng mất vết" tệ hơn "đổi thất bại".
   */
  async appendWithin(
    tx: Pick<Database, 'insert'>,
    entry: AuditEntry,
  ): Promise<void> {
    await tx.insert(auditLogTable).values(toRow(entry));
  }
}

function toRow(entry: AuditEntry) {
  return {
    actor: entry.actor,
    action: entry.action,
    objectType: entry.objectType ?? null,
    objectId: entry.objectId ?? null,
    detail: entry.detail ?? null,
  };
}
