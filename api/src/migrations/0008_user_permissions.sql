-- Story 1.6 (FR-3): 2 quyền per-user, mặc định TẮT với mọi member
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_long_term boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_recurring boolean NOT NULL DEFAULT false;
