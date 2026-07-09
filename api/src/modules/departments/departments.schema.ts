import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Bảng department — tạo bằng migration 0029_department.sql. Danh mục phòng ban QLTS tự quản (7.1). */
export const departmentTable = pgTable('department', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
