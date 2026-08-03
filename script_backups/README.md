# Backup / Restore dữ liệu QLTS

Backup **data** ra đĩa để cần thì restore nhanh (Veeam lo phần đưa bản backup ra ngoài host).
pg_dump / tar chạy **trong container** qua `docker exec` — host không cần cài client Postgres.

- `script_backups/` — chứa script (thư mục này).
- `data_backups/` — chứa file backup sinh ra (đã .gitignore).

## Backup
```bash
bash script_backups/backup.sh
```
Sinh 2 file trong `qlts/data_backups/`:
- `qlts_db_<ngày_giờ>.dump` — DB (pg_dump custom-format, nén sẵn).
- `qlts_files_<ngày_giờ>.tgz` — thư mục file `/data/files` (ảnh biên bản, file kiểm kê).

Giữ **30 ngày**, tự xóa tịnh tiến bản cũ hơn mỗi lần chạy (sửa `KEEP_DAYS` trong script, hoặc `KEEP_DAYS=60 bash script_backups/backup.sh`). Backup rỗng → script báo lỗi, không ghi đè.

## Restore
```bash
bash script_backups/restore.sh data_backups/qlts_db_20260803_120000.dump data_backups/qlts_files_20260803_120000.tgz
```
Dừng api/worker → tạo lại DB sạch → `pg_restore` → bung file → khởi động lại. **Ghi đè toàn bộ**, hỏi `yes` trước khi chạy. Chạy không tham số để liệt kê các bản có sẵn.

## Hẹn giờ tự động (tùy chọn)
- **Windows (Task Scheduler):** tạo task chạy hằng ngày:
  `"C:\Program Files\Git\bin\bash.exe" -lc "cd /f/PMH/Project_QLTS/qlts && bash script_backups/backup.sh"`
- **Linux (cron):** `0 1 * * * cd /home/qlts && bash script_backups/backup.sh >> data_backups/backup.log 2>&1`

## Lưu ý
- `.env` chứa khóa mã hóa `MAIL_ENC_KEY` (giải mã mật khẩu SMTP đã lưu). Cần lưu/bảo mật `.env` riêng — mất khóa thì password SMTP trong DB không giải mã lại được.
- Redis (`qlts_redisdata`) là hàng đợi/cache tạm — không backup.
