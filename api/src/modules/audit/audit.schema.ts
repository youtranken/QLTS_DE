import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** audit_log APPEND-ONLY (AD-10) — tạo bằng migration 0003_audit_log.sql. */
export const auditLogTable = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  objectType: text('object_type'),
  objectId: text('object_id'),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
