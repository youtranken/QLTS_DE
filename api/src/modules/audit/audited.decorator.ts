import { SetMetadata } from '@nestjs/common';

export const AUDITED_KEY = 'qlts:audited';

export interface AuditedMeta {
  action: string;
  objectType?: string;
}

/**
 * Đánh dấu route auditable (AD-10): handler thành công → bản ghi audit tự động
 * qua AuditInterceptor. Story sau chỉ cần khai báo, không viết code ghi log riêng.
 */
export const Audited = (action: string, objectType?: string) =>
  SetMetadata(AUDITED_KEY, { action, objectType } satisfies AuditedMeta);
