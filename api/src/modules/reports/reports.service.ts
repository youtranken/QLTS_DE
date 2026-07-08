import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB, type Database } from '../../database/database.module';
import {
  borrowByAsset,
  type AssetBorrowRow,
  type Paged,
} from './queries/borrow-by-asset';
import { borrowByUser, type UserBorrowRow } from './queries/borrow-by-user';
import {
  overdueRatioByMonth,
  type MonthlyOverdueRow,
} from './queries/overdue-ratio';

/** Giới hạn dãy tháng của báo cáo quá hạn (NFR-5) — chặn kỳ vô hạn. */
const MAX_MONTHS = 24;

/**
 * AD-16 — service đọc báo cáo; import trạng thái/kind từ tickets (chuỗi literal trong SQL khớp
 * ticket-states.ts). Chỉ đọc, không mutate. Query bounded theo kỳ + LIMIT (NFR-5).
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Database) {}

  borrowByAsset(
    from: string,
    to: string,
    page: number,
    pageSize: number,
  ): Promise<Paged<AssetBorrowRow>> {
    return borrowByAsset(this.db, from, to, page, pageSize);
  }

  borrowByUser(
    from: string,
    to: string,
    page: number,
    pageSize: number,
  ): Promise<Paged<UserBorrowRow>> {
    return borrowByUser(this.db, from, to, page, pageSize);
  }

  async overdueRatio(from: string, to: string): Promise<MonthlyOverdueRow[]> {
    const months =
      (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
      (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) +
      1;
    if (months > MAX_MONTHS) {
      throw new BadRequestException(`Kỳ báo cáo tối đa ${MAX_MONTHS} tháng`);
    }
    return overdueRatioByMonth(this.db, from, to);
  }
}
