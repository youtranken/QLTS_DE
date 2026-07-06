import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Bảng users — tạo bằng migration raw SQL 0002_users.sql; khóa = claim `sub` (AD-8). */
export const usersTable = pgTable('users', {
  sub: text('sub').primaryKey(),
  email: text('email'),
  employeeCode: text('employee_code'),
  fullName: text('full_name'),
  groups: jsonb('groups').notNull().default([]),
  status: text('status').notNull().default('active'),
  role: text('role').notNull().default('member'),
  firstLoginAt: timestamp('first_login_at', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
