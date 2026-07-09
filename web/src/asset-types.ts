/** Kiểu & helper dùng chung cho sổ tài sản (list / form / detail). */

export interface AssetRow {
  id: string;
  code: string;
  type: string;
  status: string;
  isPool: boolean;
  assignedUserSub: string | null;
  assignedUserName: string | null;
  /** 2.5: license term sắp hết hạn đang gắn máy không-thanh-lý → dòng đỏ. */
  licenseWarning?: boolean;
}

export interface AssetDetail extends AssetRow {
  configuration: string | null;
  cost: number | null;
  startDate: string | null;
  endDate: string | null;
  note: string | null;
  serial: string | null;
  brand: string | null;
  licenseType: string | null;
  licenseName: string | null;
  installedOnAssetId: string | null;
  installedOnCode: string | null;
  version: number;
}

export interface FormState {
  id: string | null; // null = tạo mới
  version: number;
  status: string; // đổi qua khối Vòng đời (2.6), không qua form
  isPool: boolean;
  code: string;
  type: string;
  configuration: string;
  cost: string;
  startDate: string;
  endDate: string;
  note: string;
  serial: string;
  brand: string;
  assignedUserSub: string;
  assignedUserName: string;
  // Software (2.4): isSoftware quyết định type='software' cứng + các trường license
  isSoftware: boolean;
  licenseType: string;
  licenseName: string;
  installedOnAssetId: string;
  installedOnCode: string;
}

export const EMPTY_FORM: FormState = {
  id: null,
  version: 1,
  status: 'in_use',
  isPool: false,
  code: '',
  type: '',
  configuration: '',
  cost: '',
  startDate: '',
  endDate: '',
  note: '',
  serial: '',
  brand: '',
  assignedUserSub: '',
  assignedUserName: '',
  isSoftware: false,
  licenseType: '',
  licenseName: '',
  installedOnAssetId: '',
  installedOnCode: '',
};

/** Trạng thái tài sản → lớp badge màu (vòng đời: đang dùng/khóa/thanh lý). */
export const STATUS_BADGE: Record<string, string> = {
  in_use: 'ok',
  locked_repair: 'warn',
  disposed: 'muted',
};

export interface AllocationRow {
  id: string;
  fromUserSub: string | null;
  fromUserName: string | null;
  toUserSub: string | null;
  toUserName: string | null;
  note: string | null;
  actor: string;
  actorName: string | null;
  createdAt: string;
}

export interface UserOption {
  sub: string;
  fullName: string | null;
  email: string | null;
}

export interface NoteRow {
  id: string;
  kind: string;
  note: string | null;
  eta: string | null;
  actor: string;
  actorName: string | null;
  createdAt: string;
}

/** 3.13: preview cascade (dry-run) — booking sẽ hủy + ticket in_use cần thu hồi. */
export interface CascadePreview {
  futureCancellations: Array<{
    ticketId: string;
    borrowerName: string | null;
    from: string | null;
    to: string | null;
    state: string;
  }>;
  inUseRecalls: Array<{
    ticketId: string;
    borrowerName: string | null;
    from: string | null;
    to: string | null;
  }>;
}

/** Thao tác vòng đời đang chờ Admin xác nhận trong popup. */
export interface PendingCascade {
  path: string;
  method: 'POST' | 'PUT';
  extra: Record<string, unknown>;
  patch: Partial<FormState>;
  data: CascadePreview;
}

export function detailToForm(a: AssetDetail): FormState {
  return {
    id: a.id,
    version: a.version,
    status: a.status,
    isPool: a.isPool,
    code: a.code,
    type: a.type,
    configuration: a.configuration ?? '',
    cost: a.cost == null ? '' : String(a.cost),
    startDate: a.startDate ?? '',
    endDate: a.endDate ?? '',
    note: a.note ?? '',
    serial: a.serial ?? '',
    brand: a.brand ?? '',
    assignedUserSub: a.assignedUserSub ?? '',
    assignedUserName: a.assignedUserName ?? '',
    isSoftware: a.type === 'software',
    licenseType: a.licenseType ?? '',
    licenseName: a.licenseName ?? '',
    installedOnAssetId: a.installedOnAssetId ?? '',
    installedOnCode: a.installedOnCode ?? '',
  };
}

export const fmtDateTime = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';
