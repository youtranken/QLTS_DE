-- Epic 12 (chatbot v1): lưu lịch sử hội thoại theo từng người dùng (sub).
-- chat_conversations: mỗi cuộc thuộc 1 sub. chat_messages: các lượt user/assistant.
-- KHÔNG append-only như audit_log — người dùng được tạo mới / xoá cuộc của mình.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sub text NOT NULL,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES chat_conversations (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  cards jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sidebar sắp mới→cũ theo updated_at (bump mỗi lượt); nạp message theo thứ tự thời gian.
CREATE INDEX IF NOT EXISTS idx_chat_conversations_sub ON chat_conversations (sub, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages (conversation_id, created_at);
