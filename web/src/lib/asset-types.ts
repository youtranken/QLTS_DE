/** Kiểu & helper dùng chung cho sổ tài sản (list / form / detail). */

export interface AssetRow {
  id: string;
  /** null cho phần mềm (định danh bằng licenseName). */
  code: string | null;
  type: string;
  status: string;
  isPool: boolean;
  assignedUserSub: string | null;
  assignedUserName: string | null;
  /** Mã nhân viên của người giữ (claim IDP) — cột "Employee ID" ở sổ tài sản. */
  employeeCode?: string | null;
  /** Phòng ban của người giữ (claim IDP) — cột "Department" ở sổ tài sản. */
  department?: string | null;
  /** 2.5: license term sắp hết hạn đang gắn máy không-thanh-lý → dòng đỏ. */
  licenseWarning?: boolean;
  // sw-license-model-redesign: list trả kèm để tab Phần mềm + cột "Phần mềm" ở /tai-san hiển thị.
  licenseName?: string | null;
  licenseType?: string | null;
  installedOnCode?: string | null;
  endDate?: string | null;
  /** Tên các license đang cài trên MÁY này (comma-joined) — chỉ có ở dòng máy. */
  installedSoftware?: string | null;
  // Thông số hiển thị ở bảng /tai-san (đại tu UAT) — list giờ trả kèm.
  configuration?: string | null;
  cost?: number | null;
  startDate?: string | null;
  /** Vị trí đặt máy (Place). */
  floor?: string | null;
  brand?: string | null;
  /** Ghi chú — list trả kèm để hiện cột "Ghi chú" ở chi tiết license (/phan-mem). */
  note?: string | null;
  /** Số hợp đồng mua (Contract) — list trả kèm để hiện cột ở chi tiết license. */
  contract?: string | null;
}

export interface AssetDetail extends AssetRow {
  department: string | null;
  configuration: string | null;
  cost: number | null;
  startDate: string | null;
  endDate: string | null;
  floor: string | null;
  note: string | null;
  contract: string | null;
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
  floor: string;
  note: string;
  contract: string;
  serial: string;
  brand: string;
  assignedUserSub: string;
  assignedUserName: string;
  /** Phòng ban của người giữ đã chọn — chỉ để HIỂN THỊ cạnh User (không gửi khi lưu). */
  assignedUserDepartment: string;
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
  floor: '',
  note: '',
  contract: '',
  serial: '',
  brand: '',
  assignedUserSub: '',
  assignedUserName: '',
  assignedUserDepartment: '',
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
  department?: string | null;
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

/** Chạy 1 thao tác vòng đời (khóa/gỡ-pool/thanh lý) — dùng ở form + kebab list + cascade dialog. */
export type LifecycleRun = (
  path: string,
  method: 'POST' | 'PUT',
  extra: Record<string, unknown>,
  patch: Partial<FormState>,
) => void;

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
    code: a.code ?? '',
    type: a.type,
    configuration: a.configuration ?? '',
    cost: a.cost == null ? '' : String(a.cost),
    startDate: a.startDate ?? '',
    endDate: a.endDate ?? '',
    floor: a.floor ?? '',
    note: a.note ?? '',
    contract: a.contract ?? '',
    serial: a.serial ?? '',
    brand: a.brand ?? '',
    assignedUserSub: a.assignedUserSub ?? '',
    assignedUserName: a.assignedUserName ?? '',
    assignedUserDepartment: a.department ?? '',
    isSoftware: a.type === 'software',
    licenseType: a.licenseType ?? '',
    licenseName: a.licenseName ?? '',
    installedOnAssetId: a.installedOnAssetId ?? '',
    installedOnCode: a.installedOnCode ?? '',
  };
}

/** Số tiền VND với dấu chấm phân cách nghìn: 5000000 → '5.000.000'. */
export const formatVnd = (value: number | string | null | undefined): string => {
  if (value == null || value === '') return '';
  const digits = String(value).replace(/\D/g, '');
  if (digits === '') return '';
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
};

/** Bỏ mọi ký tự không phải số khỏi ô Giá đã format (để lưu số nguyên). */
export const parseVnd = (formatted: string): string =>
  formatted.replace(/\D/g, '');

/** Ngày dạng dd/mm/yyyy từ chuỗi date-only 'YYYY-MM-DD' (không đụng timezone). */
export const formatDmy = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
};

/** Số ngày từ HÔM NAY tới ngày 'YYYY-MM-DD' (âm = đã quá hạn). Theo ngày lịch địa phương. */
export const daysUntil = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return NaN;
  const target = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86400000);
};

/** Ngưỡng "sắp hết hạn" cho cảnh báo đỏ nhấp nháy ở /phan-mem (bản/nhóm sắp hết hạn). */
export const EXPIRY_SOON_DAYS = 30;

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
