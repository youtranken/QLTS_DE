-- Epic 12 (review 12.1): siết mô hình "MỘT luồng/người" + lưu đủ payload để mở lại thấy nguyên.
-- 1) UNIQUE(sub): chống race tạo trùng cuộc (openChat + gửi song song / nhiều tab).
-- 2) detail/chips: lưu thẻ chi tiết (get_asset) + chip để reload không mất.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_conversations_sub_uniq'
  ) THEN
    ALTER TABLE chat_conversations ADD CONSTRAINT chat_conversations_sub_uniq UNIQUE (sub);
  END IF;
END $$;

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS detail jsonb;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS chips jsonb;
