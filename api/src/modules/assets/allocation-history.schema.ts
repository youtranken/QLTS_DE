import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Bảng allocation_history — migration raw SQL 0010 (story 2.3). */
export const allocationHistoryTable = pgTable('allocation_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: uuid('asset_id').notNull(),
  fromUserSub: text('from_user_sub'),
  toUserSub: text('to_user_sub'),
  note: text('note'),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
