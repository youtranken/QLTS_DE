import {
  bigint,
  boolean,
  date,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/** Bảng assets — tạo bằng migration raw SQL 0009_assets.sql (story 2.1). */
export const assetsTable = pgTable('assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull(),
  type: text('type').notNull(),
  configuration: text('configuration'),
  /** Giá VND nguyên — bigint mode number (đủ tới 2^53). */
  cost: bigint('cost', { mode: 'number' }),
  startDate: date('start_date'),
  endDate: date('end_date'),
  floor: text('floor'),
  status: text('status').notNull().default('in_use'),
  note: text('note'),
  serial: text('serial'),
  brand: text('brand'),
  model: text('model'),
  assignedUserSub: text('assigned_user_sub'),
  /** Software (2.4): term|perpetual — CHECK ở migration 0012. */
  licenseType: text('license_type'),
  licenseName: text('license_name'),
  installedOnAssetId: uuid('installed_on_asset_id'),
  isPool: boolean('is_pool').notNull().default(false),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
