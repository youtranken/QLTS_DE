-- Chặn trùng seat: 1 phần mềm (license_name) chỉ được cài 1 lần trên CÙNG 1 máy.
-- Partial unique — loại bản đã thanh lý/xóa vĩnh viễn để còn gán lại được sau khi gỡ.
CREATE UNIQUE INDEX IF NOT EXISTS uq_software_per_machine
  ON assets (installed_on_asset_id, license_name)
  WHERE type = 'software'
    AND installed_on_asset_id IS NOT NULL
    AND status <> 'disposed'
    AND purged_at IS NULL;
