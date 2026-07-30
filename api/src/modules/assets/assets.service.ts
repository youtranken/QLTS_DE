import { Injectable } from '@nestjs/common';
import type { Database } from '../../database/database.module';
import { AssetsLifecycleService } from './assets-lifecycle.service';
import type { LifecycleTx } from './assets-lifecycle.service';
import { AssetsReadService } from './assets-read.service';
import { AssetsWriteService } from './assets-write.service';

/** Trường Admin nhập được từ form (FR-30). status/is_pool KHÔNG ở đây — nghiệp vụ 2.6. */
export interface AssetInput {
  /** NULL cho phần mềm (định danh bằng license_name). Máy bắt buộc có — validate ở service. */
  code: string | null;
  type: string;
  configuration: string | null;
  cost: number | null;
  startDate: string | null;
  endDate: string | null;
  /** Vị trí đặt máy (Place). Hồi sinh sau 7.6 theo yêu cầu UAT — cột floor sẵn có. */
  floor: string | null;
  note: string | null;
  contract: string | null;
  serial: string | null;
  brand: string | null;
  assignedUserSub: string | null;
  /** Software (2.4): term|perpetual; non-software phải null. */
  licenseType: string | null;
  licenseName: string | null;
}

export interface AssetListQuery {
  page: number;
  pageSize: number;
  /** Tìm MỘT ô: khớp mã tài sản HOẶC tên người đứng tên (FR-36, story 2.2). */
  search?: string;
  type?: string;
  status?: string;
  /** 7.7: lọc "sắp hết hạn" (end_date ≤ ngưỡng) — gộp thiết bị + license. */
  expiring?: boolean;
  /** Sổ tài sản (máy) loại phần mềm ra — /phan-mem là danh sách phần mềm riêng. */
  excludeSoftware?: boolean;
  /** Lọc theo dõi hạn: end_date ∈ [endFrom, endTo] (YYYY-MM-DD, mỗi vế tuỳ chọn). */
  endFrom?: string;
  endTo?: string;
  /** Chi tiết nhóm license: lọc đúng tên license → liệt kê từng bản (seat). */
  licenseName?: string;
  /** Ẩn bản đã thanh lý (status=disposed) — /phan-mem chỉ hiện bản còn hiệu lực. */
  excludeDisposed?: boolean;
  /** Sắp xếp server-side (P1): cột (whitelist ở DTO) + hướng. Mặc định code asc. */
  sort?: string;
  dir?: string;
}

/**
 * Facade sổ tài sản (AD-1) — public API cho controller + Tickets. Logic tách theo cụm (mục 6):
 * write (create/update/delete/purge/assignOwner), read (list/getById/…), lifecycle (khóa/thanh
 * lý/pool/*Within). Chỉ delegate — giữ nguyên ranh giới module.
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly read: AssetsReadService,
    private readonly lifecycle: AssetsLifecycleService,
    private readonly write: AssetsWriteService,
  ) {}

  /**
   * Tạo tài sản — mặc định status in_use, pool TẮT (AC 1); mã trùng → 409 CODE_TAKEN.
   * Mutation + audit trong MỘT transaction (review 2.1): ghi vết thất bại →
   * rollback cả tạo (FR-35 — sổ tài sản không được "đổi mà mất vết").
   */
  create(input: AssetInput, actorSub: string, installedOnAssetId: string | null = null) {
    return this.write.create(input, actorSub, installedOnAssetId);
  }

  /**
   * Sửa tài sản — PUT full-set các trường form; optimistic lock cột `version`
   * (FR-49): version client gửi khác DB → 409 STALE_VERSION. Đọc giá trị cũ +
   * ghi mới NGUYÊN TỬ một câu lệnh (bài học 1.5 — audit from/to không đua).
   */
  update(id: string, input: AssetInput, version: number, actorSub: string, allocationNote: string | null = null) {
    return this.write.update(id, input, version, actorSub, allocationNote);
  }

  /**
   * Xóa CỨNG tài sản "sạch" (story 11.1, UAT 2026-07-12). CHỈ khi chưa phát sinh gì:
   * allocation_history + asset_note append-only (AD-10/14) + FK NOT NULL không CASCADE →
   * tài sản đã dùng KHÔNG hard-delete được — đó là đường "Thanh lý" (disposed). Xóa = sửa nhầm.
   * Guard is_pool tường minh (không phải FK nên DELETE không tự 23503).
   */
  deleteAsset(id: string, version: number, actorSub: string) {
    return this.write.deleteAsset(id, version, actorSub);
  }

  /**
   * SOFT-PURGE máy ĐÃ THANH LÝ (Kho thanh lý, "không còn dùng nữa"): set purged_at → ẨN khỏi
   * MỌI danh sách (coi như đã xóa) NHƯNG GIỮ nguyên row + allocation_history/asset_note (append-only
   * AD-10/14 — không xóa được) + audit. Hard-delete bất khả vì FK NOT NULL + trigger append-only.
   * CHỈ áp cho status='disposed' và chưa purge. Ghi audit 'assets.purge'.
   */
  purgeDisposedAsset(id: string, version: number, actorSub: string) {
    return this.write.purgeDisposedAsset(id, version, actorSub);
  }

  /**
   * Đổi người đứng tên MÁY như thao tác RIÊNG (story 11.2, B3) — tách khỏi "Lưu thông tin máy".
   * CHỈ đụng assigned_user_sub (không ghi đè trường máy khác). Optimistic lock; đổi người →
   * append allocation_history (2.3). Phần mềm KHÔNG có người đứng tên (holder derive từ máy).
   */
  assignOwner(id: string, assignedUserSub: string | null, version: number, actorSub: string, allocationNote: string | null = null) {
    return this.write.assignOwner(id, assignedUserSub, version, actorSub, allocationNote);
  }

  /**
   * Danh sách phân trang SERVER-side (NFR-5) + tìm/lọc (FR-36, story 2.2) —
   * join users lấy tên người đứng tên + host/host_user để derive holder phần mềm
   * (sw-license-model). count(*) áp CÙNG where + CÙNG join host (where có thể đụng
   * hostUser.fullName khi tìm theo người giữ máy; join PK không nhân dòng).
   */
  list(query: AssetListQuery) {
    return this.read.list(query);
  }

  /**
   * Gỡ MỌI license khỏi máy (2.5, FR-50) — 2.6 gọi TRONG tx thanh lý
   * (tx đó phải FOR UPDATE row máy trước — hợp đồng review 2.4).
   */
  detachAllFrom(tx: Pick<Database, 'execute' | 'insert'>, machineId: string, actorSub: string) {
    return this.lifecycle.detachAllFrom(tx, machineId, actorSub);
  }

  /**
   * Khóa máy sửa chữa (2.6, FR-33): BẮT BUỘC lý do, ETA tùy chọn — vào asset_note;
   * cờ pool GIỮ NGUYÊN. Chỉ từ in_use.
   */
  lock(id: string, reason: string, eta: string | null, version: number, actorSub: string) {
    return this.lifecycle.lock(id, reason, eta, version, actorSub);
  }

  unlock(id: string, version: number, actorSub: string) {
    return this.lifecycle.unlock(id, version, actorSub);
  }

  /**
   * Thanh lý (2.6, FR-32/50): TERMINAL. Máy → detachAllFrom (hợp đồng 2.5:
   * row máy đã FOR UPDATE trước); software → tự gỡ khỏi máy đang gắn.
   * Cascade hủy booking do orchestrator Tickets lo (3.10).
   */
  dispose(id: string, version: number, actorSub: string) {
    return this.lifecycle.dispose(id, version, actorSub);
  }

  /**
   * Tái sử dụng máy đã thanh lý (VĐ2): disposed → in_use, GIỮ mã MTS cũ (hoặc đổi mã mới).
   * KHÔNG tạo bản ghi mới → mã cũ không kẹt trong unique index. Đổi sang mã máy khác đang
   * dùng → PG unique violation → 409 (cảnh báo). Không cascade (máy disposed không booking).
   */
  reactivate(id: string, version: number, actorSub: string, newCode: string | null) {
    return this.lifecycle.reactivate(id, version, actorSub, newCode);
  }

  setPool(id: string, isPool: boolean, version: number, actorSub: string) {
    return this.lifecycle.setPool(id, isPool, version, actorSub);
  }

  /**
   * Khung chung 4 thao tác vòng đời (2.6): tx + FOR UPDATE row TRƯỚC (hợp đồng
   * 2.5), guard type/state (409/400), optimistic lock (409), audit; apply trả
   * detail audit (null = no-op, không audit/bump).
   */


  /**
   * Thân vòng đời KHÔNG mở tx (3.10): orchestrator Tickets gọi trong CÙNG transaction với
   * cascade hủy booking. FOR UPDATE row máy TRƯỚC (serialize với trigger AD-15 FOR SHARE),
   * guard/version/audit như 2.6. KHÔNG bọc mapPgError (caller bọc).
   */












  lockWithin(tx: LifecycleTx, id: string, reason: string, eta: string | null, version: number, actorSub: string) {
    return this.lifecycle.lockWithin(tx, id, reason, eta, version, actorSub);
  }

  unlockWithin(tx: LifecycleTx, id: string, version: number, actorSub: string) {
    return this.lifecycle.unlockWithin(tx, id, version, actorSub);
  }

  disposeWithin(tx: LifecycleTx, id: string, version: number, actorSub: string) {
    return this.lifecycle.disposeWithin(tx, id, version, actorSub);
  }

  setPoolWithin(tx: LifecycleTx, id: string, isPool: boolean, version: number, actorSub: string) {
    return this.lifecycle.setPoolWithin(tx, id, isPool, version, actorSub);
  }

  /**
   * Auto-unlock (0036): máy POOL đang khóa sửa chữa mà ETA đã tới (ngày VN) → tự mở khóa
   * để mượn lại. Sweep chạy ở worker (đăng ký ở AssetsSweepRegistrar). Bump version +
   * ghi note kind='unlock' + audit 'assets.auto_unlock' (actor 'system'). Trả số máy đã mở.
   */
  autoUnlockExpiredLocks() {
    return this.lifecycle.autoUnlockExpiredLocks();
  }

  /** Máy đích để cài software (2.4): tồn tại, KHÔNG phải software, KHÔNG thanh lý. */

  /**
   * Lịch sử cấp phát một máy (2.3, AC 3) — thời gian GIẢM dần, chỉ đọc
   * (không có endpoint sửa/xóa). Join users 3 lần lấy tên from/to/actor.
   */
  listAllocations(assetId: string) {
    return this.read.listAllocations(assetId);
  }

  listNotes(assetId: string) {
    return this.read.listNotes(assetId);
  }

  // Export Excel (2.10) TÁCH sang AssetExportService (§6): exportAssets (máy) +
  // exportSoftware (license, derive holder). Controller gọi trực tiếp service đó.

  filterMeta() {
    return this.read.filterMeta();
  }

  getById(id: string) {
    return this.read.getById(id);
  }
}

