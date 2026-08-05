-- Story 10.1: SA cục bộ (break-glass) tạo phiên với user_sub='local:sa' — sentinel KHÔNG
-- tồn tại trong bảng users. Bỏ FK sessions.user_sub -> users.sub để cho phép phiên local SA.
-- FK này chỉ là ràng buộc toàn vẹn (không phải chốt bảo mật): phiên SSO vẫn upsert users
-- TRƯỚC ở callback, và vai 'sa' của phiên local được xác định độc lập ở session-auth (không từ DB).
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_sub_fkey;
