import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AssetsService } from '../assets/assets.service';
import { AssetSoftwareService } from '../assets/asset-software.service';
import { EolService } from '../assets/eol.service';
import { BookingService } from '../booking/booking.service';
import { TicketsService } from '../tickets/tickets.service';
import { ExtensionService } from '../tickets/extension.service';
import type {
  AssetCard,
  AssetDetail,
  AssetFilter,
  Identity,
} from './chatbot.types';

/** Trần dòng đổ vào một bong bóng (G4) — kèm "hiển thị N/tổng M". */
export const RESULT_CAP = 8;

/** Trần dòng payload gửi Gemini compose (soạn câu) — con số tổng vẫn gửi đủ, chỉ cắt mảng. */
const COMPOSE_CAP = 20;

/** Escape wildcard ILIKE để khớp nghĩa đen (không phải injection — đã tham số hoá). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Lớp tool dùng chung cho guided + Gemini. Bọc service ĐÃ CÓ; QUYỀN enforce Ở ĐÂY
 * theo `identity.role` — Gemini chỉ chọn tool + args, KHÔNG quyết quyền (chống leo thang).
 */
@Injectable()
export class ChatbotToolsService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Database,
    private readonly assets: AssetsService,
    private readonly booking: BookingService,
    private readonly tickets: TicketsService,
    private readonly extension: ExtensionService,
    private readonly software: AssetSoftwareService,
    private readonly eol: EolService,
  ) {}

  /** Cảnh báo EOL: máy đủ tuổi thọ nên thanh lý + license term sắp/đã hết hạn. Admin only. */
  async eolAlerts(identity: Identity) {
    if (!(identity.role === 'admin' || identity.role === 'sa')) return null;
    const { lifespanYears, warningDays, machines, software } =
      await this.eol.list();
    return {
      thoiHanSuDungNam: lifespanYears,
      cuaSoCanhBaoNgay: warningDays,
      soMayCanThanhLy: machines.length,
      soLicenseSapHetHan: software.length,
      may: machines.slice(0, COMPOSE_CAP).map((m) => ({
        ma: m.code,
        loai: m.type,
        tuoi: m.ageYears,
        ngayEol: m.eolDate,
        conLaiNgay: m.daysToEol,
        nguoiGiu: m.assignedUserName,
      })),
      license: software.slice(0, COMPOSE_CAP).map((s) => ({
        ten: s.licenseName,
        caiTrenMay: s.installedOnCode,
        ngayHetHan: s.endDate,
        conLaiNgay: s.daysLeft,
        nguoiGiu: s.assignedUserName,
      })),
    };
  }

  /** #3 Phần mềm/license: theo tên license (số bản total/gắn/trống/sắp hết hạn). Admin only. */
  async softwareInfo(identity: Identity, name?: string) {
    if (!(identity.role === 'admin' || identity.role === 'sa')) return null;
    const licenses = await this.software.listLicenseGroups(name?.trim());
    return {
      soLicense: licenses.length,
      licenses: licenses.slice(0, COMPOSE_CAP),
    };
  }

  /** #4 Lịch sử cấp phát của MỘT máy (ai từng dùng). Member chỉ xem máy mình; admin mọi máy. */
  async assetHistory(identity: Identity, code: string) {
    const member = !(identity.role === 'admin' || identity.role === 'sa');
    const rows = await this.db.execute<{
      created_at: Date;
      from_name: string | null;
      to_name: string | null;
      actor_name: string | null;
      actor_raw: string;
      note: string | null;
    }>(sql`
      SELECT h.created_at, fu.full_name AS from_name, tu.full_name AS to_name,
             au.full_name AS actor_name, h.actor AS actor_raw, h.note
      FROM allocation_history h
      JOIN assets a ON a.id = h.asset_id
      LEFT JOIN users fu ON fu.sub = h.from_user_sub
      LEFT JOIN users tu ON tu.sub = h.to_user_sub
      LEFT JOIN users au ON au.sub = h.actor
      WHERE upper(a.code) = upper(${code}) AND a.purged_at IS NULL
        ${member ? sql`AND a.assigned_user_sub = ${identity.sub}` : sql``}
      ORDER BY h.created_at DESC
      LIMIT 20
    `);
    if (!rows.rows.length) return null;
    return {
      code,
      lichSu: rows.rows.map((r) => ({
        ngay: r.created_at,
        tu: r.from_name,
        den: r.to_name,
        boi: r.actor_name ?? r.actor_raw,
        ghiChu: r.note,
      })),
    };
  }

  /** #1 Thống kê: đếm/tổng/nhóm theo loại — SQL aggregate, chỉ trả CON SỐ (scale vô tư). */
  async assetStats(identity: Identity) {
    const member = !(identity.role === 'admin' || identity.role === 'sa');
    const where = sql`type <> 'software' AND purged_at IS NULL${
      member ? sql` AND assigned_user_sub = ${identity.sub}` : sql``
    }`;
    const agg = await this.db.execute<{
      total: number;
      in_use: number;
      repair: number;
      disposed: number;
      total_cost: string | number;
      expiring: number;
    }>(sql`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status = 'in_use')::int AS in_use,
        count(*) FILTER (WHERE status = 'locked_repair')::int AS repair,
        count(*) FILTER (WHERE status = 'disposed')::int AS disposed,
        COALESCE(sum(cost), 0)::bigint AS total_cost,
        count(*) FILTER (
          WHERE end_date IS NOT NULL
          AND end_date <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 30
        )::int AS expiring
      FROM assets WHERE ${where}
    `);
    const types = await this.db.execute<{ type: string; n: number }>(
      sql`SELECT type, count(*)::int AS n FROM assets WHERE ${where} GROUP BY type ORDER BY n DESC`,
    );
    const a = agg.rows[0];
    return {
      tongSo: a.total,
      theoTrangThai: {
        dangDung: a.in_use,
        suaChua: a.repair,
        thanhLy: a.disposed,
      },
      theoLoai: Object.fromEntries(types.rows.map((t) => [t.type, t.n])),
      tongGiaTri: formatVnd(a.total_cost),
      sapHetHan30Ngay: a.expiring,
    };
  }

  /** #2 Trạng thái mượn của tôi: các yêu cầu/booking của member (máy, hạn, trạng thái). */
  async myBorrowings(sub: string) {
    const list = await this.tickets.listMyTickets(sub);
    return list.map((t) => ({
      may: t.assetCode,
      trangThai: t.stateLabel,
      tuGio: t.from,
      denGio: t.to,
      quaHan: t.isOverdue,
    }));
  }

  /** Admin: hàng chờ duyệt + chờ gia hạn. null nếu không phải admin (member không xem được). */
  async pendingApprovals(identity: Identity) {
    if (!(identity.role === 'admin' || identity.role === 'sa')) return null;
    const [approvals, extensions] = await Promise.all([
      this.tickets.listPendingApproval(),
      this.extension.listPendingExtensions(),
    ]);
    return {
      soChoDuyet: approvals.length,
      soChoGiaHan: extensions.length,
      choDuyet: approvals.slice(0, COMPOSE_CAP),
      choGiaHan: extensions.slice(0, COMPOSE_CAP),
    };
  }

  /** Danh sách tài sản: admin/sa = toàn sổ; member = CHỈ máy mình (self-scoped, G2). */
  async searchAssets(
    identity: Identity,
    filter: AssetFilter,
  ): Promise<{ cards: AssetCard[]; total: number }> {
    if (identity.role === 'admin' || identity.role === 'sa') {
      const res = await this.assets.list({
        page: 1,
        pageSize: RESULT_CAP,
        type: filter.type,
        status: filter.status,
        endFrom: filter.endFrom,
        endTo: filter.endTo,
        search: filter.search,
        excludeSoftware: true,
      });
      return {
        cards: res.items.map((i) => ({
          code: i.code,
          type: i.type,
          holder: i.assignedUserName ?? null,
          status: i.status,
          endDate: i.endDate,
          configuration: i.configuration ?? null,
          // Admin tra cứu mã cụ thể → kèm phần mềm đang cài trên máy (installedSoftware sẵn có).
          software: i.installedSoftware ?? null,
        })),
        total: res.total,
      };
    }
    return this.selfAssets(identity.sub, filter);
  }

  /** "Máy của tôi" — self-scoped cho mọi vai (admin cũng xem máy mình giữ). */
  myAssets(sub: string): Promise<{ cards: AssetCard[]; total: number }> {
    return this.selfAssets(sub, {});
  }

  /** Máy pool còn trống trong [from,to] (read-model AD-5, không lộ người mượn). */
  async checkAvailability(
    from: string,
    to: string,
    type?: string,
  ): Promise<{ cards: AssetCard[]; total: number }> {
    const machines = await this.booking.availableMachines(
      from,
      to,
      type ?? null,
    );
    return {
      cards: machines.slice(0, RESULT_CAP).map((m) => ({
        code: m.code,
        type: m.type,
        holder: null,
        status: 'Trống',
        endDate: null,
        assetId: m.id,
        configuration: m.configuration ?? null,
      })),
      total: machines.length,
    };
  }

  /** Distinct loại máy pool — chip lọc loại. */
  assetTypes(): Promise<string[]> {
    return this.booking.assetTypes();
  }

  /** Khung GIỜ trống của máy pool trong MỘT ngày (câu "ngày X giờ nào trống"). */
  dayAvailability(date: string, type?: string) {
    return this.booking.dayFreeSlots(date, type ?? null);
  }

  /**
   * Chi tiết MỘT máy theo mã — CHỈ dựng các khía cạnh người dùng HỎI (aspects), khối phần mềm
   * tách riêng. Member chỉ xem được máy MÌNH đứng tên (self-scoped). null nếu không thấy/không quyền.
   */
  async getAsset(
    identity: Identity,
    code: string,
    aspects: string[],
  ): Promise<AssetDetail | null> {
    const memberScope = !(identity.role === 'admin' || identity.role === 'sa');
    const rows = await this.db.execute<{
      code: string | null;
      type: string;
      status: string;
      configuration: string | null;
      cost: string | number | null;
      floor: string | null;
      serial: string | null;
      brand: string | null;
      end_date: string | null;
      note: string | null;
      holder: string | null;
      software: string | null;
    }>(sql`
      SELECT a.code, a.type, a.status, a.configuration, a.cost, a.floor,
        a.serial, a.brand, a.end_date, a.note, u.full_name AS holder,
        (SELECT string_agg(sw.license_name, '||' ORDER BY sw.license_name)
         FROM assets sw
         WHERE sw.installed_on_asset_id = a.id
           AND sw.type = 'software' AND sw.status <> 'disposed'
           AND sw.license_name IS NOT NULL) AS software
      FROM assets a
      LEFT JOIN users u ON u.sub = a.assigned_user_sub
      WHERE a.type <> 'software' AND a.purged_at IS NULL
        AND upper(a.code) = upper(${code})
        ${memberScope ? sql`AND a.assigned_user_sub = ${identity.sub}` : sql``}
      LIMIT 1
    `);
    const r = rows.rows[0];
    if (!r) return null;

    const want = new Set(aspects.length ? aspects : ['config', 'software']);
    const detailRows: { label: string; value: string }[] = [];
    const add = (aspect: string, label: string, value: string | null) => {
      if (want.has(aspect) && value != null && value.trim()) {
        detailRows.push({ label, value });
      }
    };
    add('config', 'Cấu hình', r.configuration);
    add('price', 'Giá', r.cost != null ? formatVnd(r.cost) : null);
    add('place', 'Vị trí', r.floor);
    add('serial', 'Serial', r.serial);
    add('brand', 'Hãng', r.brand);
    add('warranty', 'Hạn/bảo hành đến', r.end_date);
    add('holder', 'Người giữ', r.holder);
    add('note', 'Ghi chú', r.note);

    const software = want.has('software')
      ? r.software
        ? r.software.split('||')
        : []
      : null;
    return {
      code: r.code,
      type: r.type,
      status: r.status,
      rows: detailRows,
      software,
    };
  }

  /**
   * Máy của một sub — G2: query riêng có `end_date`/`status` để member cũng lọc
   * theo ngày/trạng thái (getMyAssets không trả end_date). Self-scoped tuyệt đối.
   */
  private async selfAssets(
    sub: string,
    filter: AssetFilter,
  ): Promise<{ cards: AssetCard[]; total: number }> {
    const where = sql`assigned_user_sub = ${sub} AND type <> 'software' AND status <> 'disposed' AND purged_at IS NULL${
      filter.type ? sql` AND type = ${filter.type}` : sql``
    }${filter.status ? sql` AND status = ${filter.status}` : sql``}${
      filter.endFrom ? sql` AND end_date >= ${filter.endFrom}` : sql``
    }${filter.endTo ? sql` AND end_date <= ${filter.endTo}` : sql``}${
      filter.search
        ? sql` AND (code ILIKE ${`%${escapeLike(filter.search)}%`} OR configuration ILIKE ${`%${escapeLike(filter.search)}%`} OR brand ILIKE ${`%${escapeLike(filter.search)}%`})`
        : sql``
    }`;
    const rows = await this.db.execute<{
      code: string | null;
      type: string;
      status: string;
      end_date: string | null;
      configuration: string | null;
      software: string | null;
    }>(sql`
      SELECT a.code, a.type, a.status, a.end_date, a.configuration,
        (SELECT string_agg(sw.license_name, ', ' ORDER BY sw.license_name)
         FROM assets sw
         WHERE sw.installed_on_asset_id = a.id
           AND sw.type = 'software' AND sw.status <> 'disposed'
           AND sw.license_name IS NOT NULL) AS software
      FROM assets a
      WHERE ${where}
      ORDER BY a.code
      LIMIT ${RESULT_CAP}
    `);
    const totalRes = await this.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM assets WHERE ${where}`,
    );
    return {
      cards: rows.rows.map((r) => ({
        code: r.code,
        type: r.type,
        holder: null,
        status: r.status,
        endDate: r.end_date,
        configuration: r.configuration,
        software: r.software,
      })),
      total: totalRes.rows[0]?.n ?? 0,
    };
  }
}

/** Giá VND phân cách nghìn bằng dấu chấm (convention dự án) — không phụ thuộc ICU. */
function formatVnd(cost: string | number): string {
  const n = Number(cost);
  if (!Number.isFinite(n)) return String(cost);
  return (
    Math.round(n)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' đ'
  );
}
