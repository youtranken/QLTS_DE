import { date, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Bảng asset_note — migration raw SQL 0013 (story 2.6; 2.7 hiển thị tab). */
export const assetNoteTable = pgTable('asset_note', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: uuid('asset_id').notNull(),
  kind: text('kind').notNull(),
  note: text('note'),
  eta: date('eta'),
  actor: text('actor').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
