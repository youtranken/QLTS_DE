import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { FilesService } from '../files/files.service';
import {
  BOOKING_SESSION_LABELS_VI,
  OCCUPYING_STATES,
  TICKET_STATE_LABELS_VI,
  isTicketCancellable,
} from './ticket-states';
import type { BookingState, TicketState } from './ticket-states';
import type { MyTicket } from './tickets.service';

/**
 * Read-model ticket/booking (AD-5): các truy vấn CHỈ ĐỌC (request của tôi, hàng đợi Admin,
 * bảng "máy đang mượn", quá hạn, ảnh biên bản). Tách khỏi TicketsService (mục 6) — không
 * mutate, chỉ SELECT + serialize. TicketsService delegate để giữ public API.
 */
@Injectable()
export class TicketsReadService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly files: FilesService,
  ) {}

  async listMyTickets(borrowerSub: string): Promise<MyTicket[]> {
    const rows = await this.db.execute<{
      id: string;
      state: string;
      kind: string;
      version: number;
      created_at: string;
      asset_code: string | null;
      from_ts: string | null;
      to_ts: string | null;
      pickup_passed: boolean | null;
      is_overdue: boolean;
      overdue_minutes: number | null;
      extension_count: number;
      has_pending_ext: boolean;
      session_count: number;
    }>(sql`
      SELECT t.id, t.state, t.kind, t.version, t.created_at,
        a.code AS asset_code,
        lower(b.period) AS from_ts, upper(b.period) AS to_ts,
        t.is_overdue, t.extension_count,
        CASE WHEN t.is_overdue THEN
          EXTRACT(EPOCH FROM (now() - upper(b.period)))::int / 60
          ELSE NULL END AS overdue_minutes,
        -- giờ nhận ĐÃ QUA chưa (F5: so bằng DB now(), không Date.now()) — tính TRÊN booking
        -- còn chiếm chỗ (bỏ cancelled/returned cũ; chống false-negative khi Epic 4 đa booking)
        (SELECT min(lower(b2.period)) < now() FROM booking b2
           WHERE b2.ticket_id = t.id
             AND b2.state IN (${sql.join(
               OCCUPYING_STATES.map((s) => sql`${s}`),
               sql`, `,
             )})) AS pickup_passed,
        -- 4.1: có yêu cầu gia hạn treo? (dòng extension held)
        EXISTS (SELECT 1 FROM booking be
           WHERE be.ticket_id = t.id AND be.kind = 'extension' AND be.state = 'held')
          AS has_pending_ext,
        -- 4.5b: số buổi của chuỗi định kỳ (0 với ticket thường) → FE mở rộng xem chi tiết
        (SELECT count(*)::int FROM booking bs
           WHERE bs.ticket_id = t.id AND bs.kind = 'recurring') AS session_count
      FROM ticket t
      -- 4.5b: chuỗi định kỳ có N buổi → lấy MỘT buổi đại diện tránh nhân dòng cha.
      -- Ưu tiên buổi còn hiệu lực (held/pending/delivered) sớm nhất = "buổi kế"; nếu chuỗi
      -- đã kết thúc (mọi buổi terminal) mới rơi về buổi sớm nhất bất kỳ.
      LEFT JOIN LATERAL (
        SELECT period, asset_id FROM booking
        WHERE ticket_id = t.id AND kind <> 'extension'
        ORDER BY (state IN (${sql.join(
          OCCUPYING_STATES.map((s) => sql`${s}`),
          sql`, `,
        )})) DESC, lower(period) ASC
        LIMIT 1
      ) b ON true
      LEFT JOIN assets a ON a.id = b.asset_id
      WHERE t.borrower_sub = ${borrowerSub}
      ORDER BY t.created_at DESC
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      state: r.state,
      stateLabel: TICKET_STATE_LABELS_VI[r.state as TicketState] ?? r.state,
      kind: r.kind,
      version: r.version,
      assetCode: r.asset_code,
      from: r.from_ts ? new Date(r.from_ts).toISOString() : null,
      to: r.to_ts ? new Date(r.to_ts).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
      cancellable: isTicketCancellable(r.state, r.pickup_passed),
      isOverdue: r.is_overdue,
      overdueMinutes: r.overdue_minutes,
      extensionCount: r.extension_count,
      hasPendingExtension: r.has_pending_ext,
      sessionCount: r.session_count,
    }));
  }

  async listMyRecurringSessions(
    ticketId: string,
    borrowerSub: string,
  ): Promise<
    Array<{
      id: string;
      version: number;
      state: string;
      stateLabel: string;
      from: string | null;
      to: string | null;
      isOverdue: boolean;
      cancellable: boolean;
    }>
  > {
    const owner = await this.db.execute<{ borrower_sub: string }>(sql`
      SELECT borrower_sub FROM ticket WHERE id = ${ticketId}
    `);
    if (owner.rows.length === 0) {
      throw new NotFoundException({
        code: 'TICKET_NOT_FOUND',
        message: 'Không tìm thấy chuỗi này.',
      });
    }
    if (owner.rows[0].borrower_sub !== borrowerSub) {
      throw new ForbiddenException({
        code: 'NOT_TICKET_OWNER',
        message: 'Bạn không có quyền với chuỗi này.',
      });
    }
    const rows = await this.db.execute<{
      id: string;
      version: number;
      state: string;
      from_ts: string | null;
      to_ts: string | null;
      is_overdue: boolean;
      cancellable: boolean;
    }>(sql`
      SELECT b.id, b.version, b.state,
        lower(b.period) AS from_ts, upper(b.period) AS to_ts,
        (b.state = 'delivered' AND upper(b.period) < now()) AS is_overdue,
        -- 4.6: member hủy buổi chưa giao TRƯỚC giờ nhận (so bằng DB now())
        (b.state IN ('held', 'pending') AND lower(b.period) > now()) AS cancellable
      FROM booking b
      WHERE b.ticket_id = ${ticketId} AND b.kind = 'recurring'
      ORDER BY lower(b.period) ASC
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      version: r.version,
      state: r.state,
      stateLabel: BOOKING_SESSION_LABELS_VI[r.state as BookingState] ?? r.state,
      from: r.from_ts ? new Date(r.from_ts).toISOString() : null,
      to: r.to_ts ? new Date(r.to_ts).toISOString() : null,
      isOverdue: r.is_overdue,
      cancellable: r.cancellable,
    }));
  }

  async listPendingApproval(): Promise<
    Array<{
      id: string;
      version: number;
      kind: string;
      borrowerSub: string;
      borrowerName: string | null;
      assetCode: string | null;
      from: string | null;
      to: string | null;
      sessionCount: number;
      createdAt: string;
    }>
  > {
    const rows = await this.db.execute<{
      id: string;
      version: number;
      kind: string;
      borrower_sub: string;
      borrower_name: string | null;
      asset_code: string | null;
      from_ts: string | null;
      to_ts: string | null;
      session_count: number;
      created_at: string;
    }>(sql`
      SELECT t.id, t.version, t.kind, t.borrower_sub,
        u.full_name AS borrower_name, a.code AS asset_code,
        lower(b.period) AS from_ts, upper(b.period) AS to_ts,
        -- chuỗi định kỳ: đếm số buổi đang chờ duyệt để hiển thị "N buổi"
        (SELECT count(*)::int FROM booking bs
           WHERE bs.ticket_id = t.id AND bs.kind = 'recurring' AND bs.state = 'held')
          AS session_count,
        t.created_at
      FROM ticket t
      LEFT JOIN users u ON u.sub = t.borrower_sub
      -- buổi sớm nhất làm đại diện khung giờ (chuỗi lấy buổi đầu; thường lấy held đơn)
      LEFT JOIN LATERAL (
        SELECT period, asset_id FROM booking
        WHERE ticket_id = t.id AND state = 'held'
        ORDER BY lower(period) ASC LIMIT 1
      ) b ON true
      LEFT JOIN assets a ON a.id = b.asset_id
      WHERE t.state = 'pending_approval'
      ORDER BY t.created_at ASC
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      version: r.version,
      kind: r.kind,
      borrowerSub: r.borrower_sub,
      borrowerName: r.borrower_name,
      assetCode: r.asset_code,
      from: r.from_ts ? new Date(r.from_ts).toISOString() : null,
      to: r.to_ts ? new Date(r.to_ts).toISOString() : null,
      sessionCount: r.session_count,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async listQueue(ticketState: 'awaiting_pickup' | 'in_use'): Promise<
    Array<{
      id: string;
      version: number;
      borrowerName: string | null;
      assetCode: string | null;
      from: string | null;
      to: string | null;
      isOverdue: boolean;
      overdueMinutes: number | null;
    }>
  > {
    const rows = await this.db.execute<{
      id: string;
      version: number;
      borrower_name: string | null;
      asset_code: string | null;
      from_ts: string | null;
      to_ts: string | null;
      is_overdue: boolean;
      overdue_minutes: number | null;
    }>(sql`
      SELECT t.id, t.version, u.full_name AS borrower_name, a.code AS asset_code,
        lower(b.period) AS from_ts, upper(b.period) AS to_ts,
        t.is_overdue,
        -- F9: badge đỏ + thời lượng quá hạn NGAY trên queue đang mượn (3.8 Task 5)
        CASE WHEN t.is_overdue THEN
          EXTRACT(EPOCH FROM (now() - upper(b.period)))::int / 60
          ELSE NULL END AS overdue_minutes
      FROM ticket t
      LEFT JOIN users u ON u.sub = t.borrower_sub
      -- 9.10: CHỈ booking mượn chính (kind='normal'). Bỏ 'extension' state='held' —
      -- nếu không, ticket đang gia hạn khớp cả booking delivered LẪN extension → nhân đôi dòng.
      LEFT JOIN booking b ON b.ticket_id = t.id
        AND b.kind = 'normal'
        AND b.state IN (${sql.join(
          OCCUPYING_STATES.map((s) => sql`${s}`),
          sql`, `,
        )})
      LEFT JOIN assets a ON a.id = b.asset_id
      -- 4.5a: chuỗi định kỳ giao/nhận theo BUỔI (queue riêng) — loại parent recurring khỏi
      -- queue ticket-level, tránh N dòng trùng + nút giao/nhận sai luồng.
      WHERE t.state = ${ticketState} AND t.kind = 'normal'
      -- quá hạn nổi lên đầu (sort — 3.8 AC1), rồi tới giờ nhận/trả sớm nhất
      ORDER BY t.is_overdue DESC, lower(b.period) ASC, t.created_at
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      version: r.version,
      borrowerName: r.borrower_name,
      assetCode: r.asset_code,
      from: r.from_ts ? new Date(r.from_ts).toISOString() : null,
      to: r.to_ts ? new Date(r.to_ts).toISOString() : null,
      isOverdue: r.is_overdue,
      overdueMinutes: r.overdue_minutes,
    }));
  }

  async listInUseNow(): Promise<
    Array<{
      borrowerName: string | null;
      assetCode: string | null;
      from: string | null;
      to: string | null;
    }>
  > {
    const rows = await this.db.execute<{
      borrower_name: string | null;
      asset_code: string | null;
      from_ts: string | null;
      to_ts: string | null;
    }>(sql`
      SELECT u.full_name AS borrower_name, a.code AS asset_code,
        lower(b.period) AS from_ts, upper(b.period) AS to_ts
      FROM ticket t
      JOIN booking b ON b.ticket_id = t.id AND b.state = 'delivered'
      LEFT JOIN users u ON u.sub = t.borrower_sub
      LEFT JOIN assets a ON a.id = b.asset_id
      WHERE t.state = 'in_use'
      ORDER BY upper(b.period) ASC
    `);
    return rows.rows.map((r) => ({
      borrowerName: r.borrower_name,
      assetCode: r.asset_code,
      from: r.from_ts ? new Date(r.from_ts).toISOString() : null,
      to: r.to_ts ? new Date(r.to_ts).toISOString() : null,
    }));
  }

  async listBoard(callerSub: string): Promise<
    Array<{
      ticketId: string;
      assetCode: string | null;
      type: string | null;
      borrowerName: string | null;
      from: string | null;
      due: string | null;
      state: string;
      isOverdue: boolean;
      isMine: boolean;
      note: string | null;
      recurringCount: number | null;
      version: number;
      kind: string;
      extensionCount: number;
      hasPendingExtension: boolean;
    }>
  > {
    const rows = await this.db.execute<{
      ticket_id: string;
      asset_code: string | null;
      type: string | null;
      borrower_name: string | null;
      from_ts: string | null;
      due_ts: string | null;
      state: string;
      is_overdue: boolean;
      is_mine: boolean;
      note: string | null;
      recurring_count: number | null;
      version: number;
      kind: string;
      extension_count: number;
      has_pending_extension: boolean;
    }>(sql`
      SELECT ticket_id, asset_code, type, borrower_name, from_ts, due_ts,
        state, is_overdue, is_mine, note, recurring_count, version, kind,
        extension_count, has_pending_extension
      FROM (
        -- DISTINCT ON (t.id): chuỗi định kỳ = 1 ticket nhiều buổi cùng state (N held/pending/
        -- delivered) → gộp về 1 dòng/ticket (buổi có due sớm nhất), như listOverdue/listQueue.
        -- Thiếu bước này → board nhân N dòng cùng ticketId, FE key trùng (review FL-4).
        SELECT DISTINCT ON (t.id)
          t.id AS ticket_id, a.code AS asset_code, a.type AS type,
          u.full_name AS borrower_name,
          lower(b.period) AS from_ts, upper(b.period) AS due_ts,
          t.state AS state, t.is_overdue AS is_overdue,
          (t.borrower_sub = ${callerSub}) AS is_mine,
          -- Note do member tự nhập là RIÊNG TƯ: chỉ chủ ticket thấy, không public trên board
          -- (AD-5 read-model công khai chỉ tên+máy+khung giờ; review P0 3.1).
          CASE WHEN t.borrower_sub = ${callerSub} THEN b.note END AS note,
          CASE WHEN t.kind = 'recurring'
            THEN (SELECT count(*)::int FROM booking bb
                  WHERE bb.ticket_id = t.id AND bb.kind = 'recurring')
            END AS recurring_count,
          -- Gia hạn (Epic 4): version cho optimistic lock member, kind để ẩn ở buổi định kỳ,
          -- đếm lần đã dùng + cờ đang có yêu cầu treo (ẩn nút xin ở member).
          t.version AS version, t.kind AS kind, t.extension_count AS extension_count,
          EXISTS (SELECT 1 FROM booking be
            WHERE be.ticket_id = t.id AND be.kind = 'extension' AND be.state = 'held')
            AS has_pending_extension
        FROM ticket t
        JOIN booking b ON b.ticket_id = t.id
        LEFT JOIN assets a ON a.id = b.asset_id
        LEFT JOIN users u ON u.sub = t.borrower_sub
        WHERE (t.state = 'in_use' AND b.state = 'delivered')
           OR (t.borrower_sub = ${callerSub}
               AND ((t.state = 'awaiting_pickup' AND b.state = 'pending')
                    OR (t.state = 'pending_approval' AND b.state = 'held')))
        ORDER BY t.id, upper(b.period) ASC
      ) q
      ORDER BY q.is_overdue DESC, (q.state = 'in_use') DESC, q.due_ts ASC
    `);
    return rows.rows.map((r) => ({
      ticketId: r.ticket_id,
      assetCode: r.asset_code,
      type: r.type,
      borrowerName: r.borrower_name,
      from: r.from_ts ? new Date(r.from_ts).toISOString() : null,
      due: r.due_ts ? new Date(r.due_ts).toISOString() : null,
      state: r.state,
      isOverdue: r.is_overdue,
      isMine: r.is_mine,
      note: r.note,
      recurringCount: r.recurring_count,
      version: r.version,
      kind: r.kind,
      extensionCount: r.extension_count,
      hasPendingExtension: r.has_pending_extension,
    }));
  }

  /** Danh sách ticket đang quá hạn (dashboard 3.12) — sort thời lượng quá hạn giảm dần. */
  async listOverdue(): Promise<
    Array<{
      id: string;
      borrowerName: string | null;
      assetCode: string | null;
      dueAt: string | null;
      overdueMinutes: number;
    }>
  > {
    // DISTINCT ON (t.id): ticket nhiều booking delivered (định kỳ Epic 4) → 1 dòng/ticket,
    // lấy booking quá hạn LÂU nhất (upper sớm nhất). Sort ngoài theo thời lượng giảm dần.
    const rows = await this.db.execute<{
      id: string;
      borrower_name: string | null;
      asset_code: string | null;
      due_at: string | null;
      overdue_minutes: number;
    }>(sql`
      SELECT id, borrower_name, asset_code, due_at, overdue_minutes FROM (
        SELECT DISTINCT ON (t.id) t.id, u.full_name AS borrower_name, a.code AS asset_code,
          upper(b.period) AS due_at,
          EXTRACT(EPOCH FROM (now() - upper(b.period)))::int / 60 AS overdue_minutes
        FROM ticket t
        JOIN booking b ON b.ticket_id = t.id AND b.state = 'delivered'
        LEFT JOIN users u ON u.sub = t.borrower_sub
        LEFT JOIN assets a ON a.id = b.asset_id
        WHERE t.state = 'in_use' AND t.is_overdue = true
        ORDER BY t.id, upper(b.period) ASC
      ) q
      ORDER BY overdue_minutes DESC
    `);
    return rows.rows.map((r) => ({
      id: r.id,
      borrowerName: r.borrower_name,
      assetCode: r.asset_code,
      dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
      overdueMinutes: r.overdue_minutes,
    }));
  }

  /** Tab "Mượn-trả" của máy (FR-34): ticket/buổi của máy — người mượn, khung, giao/nhận, trạng thái. */
  async listAssetHandovers(
    assetId: string,
    page = 1,
    pageSize = 20,
  ): Promise<{
    items: unknown[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const offset = (page - 1) * pageSize;
    const [items, totalRows] = await Promise.all([
      this.db.execute<{
        ticket_id: string;
        state: string;
        borrower_name: string | null;
        from_ts: string;
        to_ts: string;
        delivered_at: string | null;
        returned_at: string | null;
        is_overdue: boolean;
        overdue_minutes: number | null;
        photo_count: number;
      }>(sql`
        SELECT t.id AS ticket_id,
          -- FL-3: chuỗi định kỳ = 1 ticket nhiều buổi → state/mốc/quá-hạn phải THEO BUỔI
          -- (b.*), không lấy rollup cha (t.*) như trước (mọi buổi hiện state cha + NULL mốc).
          -- Buổi thường (kind='normal') vẫn theo ticket cha.
          CASE WHEN t.kind = 'recurring' THEN
            CASE b.state
              WHEN 'held' THEN 'pending_approval'
              WHEN 'pending' THEN 'awaiting_pickup'
              WHEN 'delivered' THEN 'in_use'
              WHEN 'returned' THEN 'closed'
              ELSE b.state END
          ELSE t.state END AS state,
          u.full_name AS borrower_name,
          lower(b.period) AS from_ts, upper(b.period) AS to_ts,
          CASE WHEN t.kind = 'recurring' THEN b.delivered_at ELSE t.delivered_at END AS delivered_at,
          CASE WHEN t.kind = 'recurring' THEN b.returned_at ELSE t.returned_at END AS returned_at,
          -- FL-9: quá hạn THEO BUỔI (buổi delivered & đã quá hạn), không theo cờ cha rollup
          -- (trước đây buổi đã trả/tương lai của chuỗi quá hạn bị gắn cờ + phút âm/vô nghĩa).
          (b.state = 'delivered' AND upper(b.period) < now()) AS is_overdue,
          -- UP-5.5: số ảnh biên bản của ticket → FE chỉ hiện nút "Xem ảnh" khi >0
          (SELECT count(*)::int FROM ticket_file tf WHERE tf.ticket_id = t.id) AS photo_count,
          CASE WHEN b.state = 'delivered' AND upper(b.period) < now() THEN
            EXTRACT(EPOCH FROM (now() - upper(b.period)))::int / 60
            ELSE NULL END AS overdue_minutes
        FROM booking b
        JOIN ticket t ON t.id = b.ticket_id
        LEFT JOIN users u ON u.sub = t.borrower_sub
        WHERE b.asset_id = ${assetId} AND b.kind IN ('normal', 'recurring')
          AND b.state <> 'cancelled'
        ORDER BY lower(b.period) DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `),
      this.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM booking b
        WHERE b.asset_id = ${assetId} AND b.kind IN ('normal', 'recurring')
          AND b.state <> 'cancelled'
      `),
    ]);
    return {
      items: items.rows.map((r) => ({
        ticketId: r.ticket_id,
        state: r.state,
        stateLabel: TICKET_STATE_LABELS_VI[r.state as TicketState] ?? r.state,
        borrowerName: r.borrower_name,
        from: new Date(r.from_ts).toISOString(),
        to: new Date(r.to_ts).toISOString(),
        deliveredAt: r.delivered_at
          ? new Date(r.delivered_at).toISOString()
          : null,
        returnedAt: r.returned_at
          ? new Date(r.returned_at).toISOString()
          : null,
        isOverdue: r.is_overdue,
        overdueMinutes: r.overdue_minutes,
        photoCount: r.photo_count,
      })),
      total: totalRows.rows[0]?.n ?? 0,
      page,
      pageSize,
    };
  }

  async listTicketPhotos(
    ticketId: string,
    requesterSub: string,
    requesterRole: string,
  ) {
    const owner = await this.db.execute<{ borrower_sub: string }>(sql`
      SELECT borrower_sub FROM ticket WHERE id = ${ticketId}
    `);
    if (owner.rows.length === 0) {
      throw new NotFoundException({
        code: 'TICKET_NOT_FOUND',
        message: 'Không tìm thấy ticket.',
      });
    }
    const isAdmin = requesterRole === 'admin' || requesterRole === 'sa';
    if (!isAdmin && owner.rows[0].borrower_sub !== requesterSub) {
      throw new ForbiddenException({
        code: 'NOT_TICKET_OWNER',
        message: 'Bạn không có quyền xem ảnh này.',
      });
    }
    const files = await this.db.execute<{ file_id: string; phase: string }>(sql`
      SELECT file_id, phase FROM ticket_file
      WHERE ticket_id = ${ticketId}
      ORDER BY phase, file_id
    `);
    return files.rows.map((r) => ({ fileId: r.file_id, phase: r.phase }));
  }

  async getTicketPhoto(
    ticketId: string,
    fileId: string,
    requesterSub: string,
    requesterRole: string,
  ) {
    const rows = await this.db.execute<{ borrower_sub: string }>(sql`
      SELECT t.borrower_sub FROM ticket t
      JOIN ticket_file tf ON tf.ticket_id = t.id AND tf.file_id = ${fileId}
      WHERE t.id = ${ticketId}
    `);
    if (rows.rows.length === 0) {
      throw new NotFoundException({
        code: 'PHOTO_NOT_FOUND',
        message: 'Không tìm thấy ảnh của ticket này.',
      });
    }
    const isAdmin = requesterRole === 'admin' || requesterRole === 'sa';
    if (!isAdmin && rows.rows[0].borrower_sub !== requesterSub) {
      throw new ForbiddenException({
        code: 'NOT_TICKET_OWNER',
        message: 'Bạn không có quyền xem ảnh này.',
      });
    }
    return this.files.openForDownload(fileId, requesterSub);
  }
}
