import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Bảng files — migration raw SQL 0015 (story 2.8, AD-6). */
export const filesTable = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  originalName: text('original_name').notNull(),
  mime: text('mime').notNull(),
  kind: text('kind').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  uploadedBy: text('uploaded_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
