import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Bảng catalog — tạo bằng migration 0031_catalog.sql. Danh mục Loại/Hãng/Cấu hình (8.1). */
export const catalogTable = pgTable('catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CatalogKind =
  | 'type'
  | 'brand'
  | 'configuration'
  | 'place'
  | 'licenseName';
export const CATALOG_KINDS: readonly CatalogKind[] = [
  'type',
  'brand',
  'configuration',
  'place',
  'licenseName',
];
