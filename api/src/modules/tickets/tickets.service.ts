import { Injectable } from '@nestjs/common';
import { TicketsApprovalService } from './tickets-approval.service';
import { TicketsBookingService } from './tickets-booking.service';
import { TicketsHandoverService } from './tickets-handover.service';
import { TicketsLifecycleService } from './tickets-lifecycle.service';
import { TicketsReadService } from './tickets-read.service';
import { TicketsSweepService } from './tickets-sweep.service';

export interface SubmitBookingInput {
  assetId: string;
  from: string;
  to: string;
  note?: string | null;
}

export interface MyTicket {
  id: string;
  state: string;
  stateLabel: string;
  kind: string;
  version: number;
  assetCode: string | null;
  from: string | null;
  to: string | null;
  createdAt: string;
  cancellable: boolean;
  isOverdue: boolean;
  overdueMinutes: number | null;
  extensionCount: number;
  hasPendingExtension: boolean;
  sessionCount: number;
}

export interface SubmitBookingResult {
  ticketId: string;
  bookingId: string;
  ticketState: string;
  bookingState: string;
  autoApproved: boolean;
}

@Injectable()
export class TicketsService {
  constructor(
    private readonly lifecycle: TicketsLifecycleService,
    private readonly read: TicketsReadService,
    private readonly sweep: TicketsSweepService,
    private readonly approval: TicketsApprovalService,
    private readonly handover: TicketsHandoverService,
    private readonly booking: TicketsBookingService,
  ) {}

  // Vòng đời máy cascade (lock/unlock/dispose/setPool/preview) → TicketsLifecycleService.
  lockAssetCascade(
    assetId: string,
    reason: string,
    eta: string | null,
    version: number,
    actorSub: string,
    notify = true,
  ) {
    return this.lifecycle.lockAssetCascade(
      assetId,
      reason,
      eta,
      version,
      actorSub,
      notify,
    );
  }

  unlockAsset(assetId: string, version: number, actorSub: string) {
    return this.lifecycle.unlockAsset(assetId, version, actorSub);
  }

  disposeAssetCascade(
    assetId: string,
    version: number,
    actorSub: string,
    notify = true,
  ) {
    return this.lifecycle.disposeAssetCascade(assetId, version, actorSub, notify);
  }

  setPoolCascade(
    assetId: string,
    isPool: boolean,
    version: number,
    actorSub: string,
    notify = true,
  ) {
    return this.lifecycle.setPoolCascade(assetId, isPool, version, actorSub, notify);
  }

  previewLifecycleCascade(assetId: string) {
    return this.lifecycle.previewLifecycleCascade(assetId);
  }

  /**
   * Member tự đặt máy (FR-8, AD-4). ≤48h → tự duyệt (awaiting_pickup/pending);
   * >48h cần quyền dài hạn → giữ chỗ (pending_approval/held, hàng đợi Admin 3.4).
   * Quota + quyền dài hạn kiểm trong CÙNG transaction sau SELECT … FOR UPDATE hàng user
   * — đóng cả race quota lẫn TOCTOU thu quyền (review 3.1c). Đúng-sai chồng giờ/bookability
   * do DB ép (AD-2/AD-15) — mapBookingPgError dịch 409.
   */
  submitOwnBooking(input: SubmitBookingInput, borrowerSub: string) {
    return this.booking.submitOwnBooking(input, borrowerSub);
  }

  /**
   * Admin tạo request HỘ member (FR-12) — BỎ QUA quota + quyền per-user, VẪN EXCLUDE (AD-2)
   * + bookability (AD-15). Skip-quota chỉ hợp lệ khi actor (Admin) ≠ borrower (AD-4). Hai chế
   * độ: 'now' (giao ngay → in_use/delivered) | 'schedule' (đặt lịch → awaiting_pickup/pending).
   */
  createForMember(
    input: {
      borrowerSub: string;
      assetId: string;
      from: string;
      to: string;
      mode: 'now' | 'schedule';
      note: string | null;
      photoIds: string[];
    },
    actorSub: string,
  ) {
    return this.booking.createForMember(input, actorSub);
  }

  /**
   * "Request của tôi" (FR-11, NFR-7) — CHỈ ticket của member đó (WHERE borrower_sub).
   * Kèm nhãn tiếng Việt (AD-16) + máy + khung giờ + cờ hủy được (FE ẩn/hiện nút).
   */
  listMyTickets(borrowerSub: string) {
    return this.read.listMyTickets(borrowerSub);
  }

  /**
   * Chi tiết các buổi của một chuỗi định kỳ (4.5b) — CHỈ chủ chuỗi (IDOR: borrower≠sub → 403).
   * FE mở rộng dòng cha để xem từng buổi + trạng thái. Sort theo giờ tăng dần.
   */
  listMyRecurringSessions(ticketId: string, borrowerSub: string) {
    return this.read.listMyRecurringSessions(ticketId, borrowerSub);
  }

  /**
   * Member tự hủy ticket của mình (FR-11). IDOR: borrower≠sub → 403. Optimistic
   * lock: version lệch → 409 STALE_VERSION (Admin thao tác cùng ticket, FR-49).
   * Hủy → ticket+booking cancelled, khung nhả (rời OCCUPYING), quota giải phóng.
   */
  cancelMyTicket(ticketId: string, borrowerSub: string, version: number) {
    return this.booking.cancelMyTicket(ticketId, borrowerSub, version);
  }

  /**
   * Admin hủy CƯỠNG CHẾ ticket của người khác (audit H-2) — lối thoát vận hành.
   * Trước bản vá này KHÔNG có đường nào gỡ một ticket đã duyệt nhưng kẹt: member không
   * hủy được sau giờ nhận, autoCloseNoShow chỉ chạy khi hết period, sweep bỏ qua
   * 'pending' → máy giam tới khi can thiệp SQL tay.
   *
   * Khác `cancelMyTicket`: KHÔNG kiểm chủ sở hữu, KHÔNG kiểm pickup_passed, KHÔNG cần
   * version (admin quyết trên hiện trạng). Vẫn chặn trạng thái đã kết thúc và chuỗi
   * định kỳ (kind='recurring' có đường hủy riêng đi qua deriveParentState — AD-4).
   *
   * CHỈ cho pending_approval + awaiting_pickup (review M1): ticket 'in_use' là máy ĐÃ GIAO
   * thật, hủy sẽ nhả booking → poolFreeNow thấy máy free trong khi nó còn ở tay người mượn
   * (double-allocation, không vết thu hồi). Máy in_use phải đi đường Trả (returnTicket).
   */
  adminForceCancel(ticketId: string, actorSub: string, reason: string) {
    return this.booking.adminForceCancel(ticketId, actorSub, reason);
  }

  /**
   * Hàng đợi Admin "Chờ duyệt" (FR-13) — request >48h/định kỳ đang giữ chỗ (held).
   * Admin THẤY tên người mượn (hàng đợi nội bộ, khác read-model AD-5 công khai).
   */
  listPendingApproval() {
    return this.read.listPendingApproval();
  }

  /**
   * Hàng đợi Admin theo trạng thái (FR-45): chờ giao (awaiting_pickup) / đang mượn (in_use).
   * Kèm tên người mượn + máy + khung + version cho nút giao/nhận. Booking occupying của ticket.
   */
  listQueue(ticketState: 'awaiting_pickup' | 'in_use') {
    return this.read.listQueue(ticketState);
  }

  /**
   * "Máy đang được mượn" (NFR-2, 3.11) — read-model CÔNG KHAI NỘI BỘ cho member: snapshot
   * hiện tại, CHỈ display name + máy + khung. AD-5: KHÔNG sub/email, KHÔNG filter theo người,
   * KHÔNG phân trang lịch sử. Sort theo hạn trả tăng dần (sắp trả trước).
   */
  listInUseNow() {
    return this.read.listInUseNow();
  }

  /**
   * Bảng "Máy đang mượn" (7.4) — read-model realtime cho trang chủ.
   * Trả: MỌI ticket in_use (delivered) toàn hệ + vé chờ nhận/chờ duyệt của CHÍNH caller.
   * AD-5: read-only join, KHÔNG sub/email — chỉ full_name; borrowerName hiện cho mọi vai
   * (chốt 2026-07-09, khác in-use-now). Map trạng thái: in_use↔delivered, awaiting_pickup↔pending,
   * pending_approval(long-term)↔held (AD-16). is_overdue = cờ reversible (AD-14) cho badge+sort.
   */
  listBoard(callerSub: string) {
    return this.read.listBoard(callerSub);
  }



  /**
   * Ghi vết lần thử THUA (AC 4) — NGOÀI transaction quyết định (tx đó đã rollback theo throw,
   * appendWithin trong tx sẽ mất vết). Best-effort: lỗi audit không che lỗi gốc.
   */


  approveRequest(ticketId: string, version: number, actorSub: string) {
    return this.approval.approveRequest(ticketId, version, actorSub);
  }

  rejectRequest(ticketId: string, version: number, reason: string, actorSub: string) {
    return this.approval.rejectRequest(ticketId, version, reason, actorSub);
  }

  /**
   * Chuyển 1 ticket pending_approval quá giờ nhận → cancelled TRONG tx cho trước:
   * ticket→cancelled, booking held→cancelled, audit actor=system. Không mở tx mới.
   */


  /**
   * Sweep handler (AD-9, 3.5b): request `pending_approval` có giờ nhận đã trôi qua →
   * tự hết hạn, nhả khung, quota giải phóng, audit actor=system. Idempotent: mỗi ticket
   * re-lock + re-check pending_approval + pickup<now trong tx riêng (chạy lại vô hại).
   * Deadline derive từ Postgres → Redis chết/sống, sweep kế bù hết. Trả số ticket expire.
   */
  expireStalePendingApprovals() {
    return this.approval.expireStalePendingApprovals();
  }

  /**
   * Expire-on-conflict (AD-9): trong tx submit, giải phóng dòng `held` (pending_approval)
   * trên máy `assetId` chồng khung [from,to) mà giờ nhận (lower) đã qua. CHỈ held quá giờ —
   * không đụng booking còn hạn / đang mượn.
   * KHÔNG đụng `pending` (awaiting_pickup) trễ giờ nhận: khung còn hiệu lực (upper>now) nghĩa là
   * member VẪN giữ chỗ hợp lệ (đang được nhắc pickup) — không cướp; còn khi upper<now thì booking
   * mới của B (from≥now) không thể chồng nên không có "SLOT_TAKEN giả" (review Epic 3 F4).
   * THỨ TỰ KHÓA ticket → booking (giống sweep) để KHÔNG deadlock (review Med): tìm ticket_id
   * (không FOR UPDATE booking) → khóa ticket trước → cancelExpiredWithin update booking sau.
   */


  /**
   * Sweep handler (AD-14, 3.8): ticket `in_use` có booking `delivered` quá hạn trả
   * (upper period < now) chưa gắn cờ → bật is_overdue + overdue_marked_at (một lần, COALESCE
   * — không ghi đè). CHỈ cờ, KHÔNG đụng booking.state. Idempotent. KHÔNG phát mail (5.3 chủ).
   */
  markOverdue() {
    return this.sweep.markOverdue();
  }

  listOverdue() {
    return this.read.listOverdue();
  }





  deliver(ticketId: string, version: number, note: string | null, photoIds: string[], actorSub: string) {
    return this.handover.deliver(ticketId, version, note, photoIds, actorSub);
  }

  /** Admin xác nhận "Đã nhận" (FR-14/17): in_use → closed, booking delivered → returned.
   * Note BẮT BUỘC (controller ép) → asset_note handover. Trả sớm = close sớm (không kiểm giờ). */
  returnTicket(ticketId: string, version: number, note: string, photoIds: string[], actorSub: string) {
    return this.handover.returnTicket(ticketId, version, note, photoIds, actorSub);
  }

  listAssetHandovers(assetId: string, page = 1, pageSize = 20) {
    return this.read.listAssetHandovers(assetId, page, pageSize);
  }

  /**
   * UP-5.5: liệt kê ảnh đính kèm một ticket (fileId + phase) để FE dựng gallery/lightbox.
   * Cùng chốt quyền như getTicketPhoto: CHỦ ticket hoặc admin/sa. Chỉ meta id — stream
   * vẫn đi qua route serve từng file (đã kiểm ticket_file lần nữa).
   */
  listTicketPhotos(ticketId: string, requesterSub: string, requesterRole: string) {
    return this.read.listTicketPhotos(ticketId, requesterSub, requesterRole);
  }

  /**
   * Mở ảnh đính kèm ticket (NFR-8/AD-6): CHỈ chủ ticket HOẶC admin/sa. File phải thuộc
   * ticket (ticket_file) — chống đọc file id bất kỳ. Trả stream qua FilesService.
   */
  getTicketPhoto(ticketId: string, fileId: string, requesterSub: string, requesterRole: string) {
    return this.read.getTicketPhoto(ticketId, fileId, requesterSub, requesterRole);
  }

  /**
   * Sweep handler (FR-16, 3.9): ticket `awaiting_pickup` CHƯA giao đã trôi qua hết hạn mượn
   * (booking pending upper < now) → closed + close_reason='no_show', booking cancelled (KHÔNG
   * returned), khung nhả, quota giải phóng; audit actor=system. Idempotent (per-ticket re-check).
   * KHÔNG đụng in_use (đã giao → luồng overdue 3.8).
   */
  autoCloseNoShow() {
    return this.sweep.autoCloseNoShow();
  }

  /**
   * Sweep handler (FR-26, 3.9): booking `pending` (ticket awaiting_pickup) đã tới giờ nhận
   * (lower < now) NHƯNG chưa hết hạn (upper > now) và CHƯA nhắc → set pickup_reminder_at + ghi
   * outbox 'pickup_reminder' MỘT LẦN/booking (marker chống lặp 180 event; party phiên 7).
   * Payload chỉ id (AD-11). Mail consumer là Epic 5.
   */
  emitPickupReminders() {
    return this.sweep.emitPickupReminders();
  }
}
