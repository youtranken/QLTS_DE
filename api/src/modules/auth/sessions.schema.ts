import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Phiên server-side (AD-8) — tạo bằng migration 0004_sessions.sql. */
export const sessionsTable = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  userSub: text('user_sub').notNull(),
  refreshToken: text('refresh_token'),
  accessTokenExp: timestamp('access_token_exp', { withTimezone: true }),
  claims: jsonb('claims'),
  // id_token lúc login — dùng làm id_token_hint khi logout (bai-hoc-sso #5)
  idToken: text('id_token'),
  csrfToken: text('csrf_token').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
