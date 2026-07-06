import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Bảng config (FR-44) — tạo/seed bằng migration raw SQL 0001_config.sql. */
export const configTable = pgTable('config', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
