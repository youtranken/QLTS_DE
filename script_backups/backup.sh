#!/usr/bin/env bash
# Backup toàn bộ dữ liệu QLTS: DB (pg_dump custom-format) + thư mục file (ảnh biên bản/kiểm kê).
# pg_dump/tar chạy NGAY TRONG container qua `docker exec` → không cần cài client trên host.
# Xuất ra <repo>/qlts/data_backups/, xoay vòng giữ KEEP bản mới nhất. Veeam lo phần đưa ra ngoài.
set -euo pipefail

# Git-Bash (Windows) tự đổi '/data/files' thành đường dẫn Windows → tắt đi. Vô hại trên Linux.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

# Tên container = <project>-<service>-1. Chốt COMPOSE_PROJECT_NAME=qlts trong .env để luôn là
# 'qlts-*' dù thư mục clone tên khác (prod: QLTS_DE). Override được: PG_CONTAINER=... bash backup.sh
PG_CONTAINER=${PG_CONTAINER:-qlts-postgres-1}
FILES_CONTAINER=${FILES_CONTAINER:-qlts-api-1}
PG_USER=qlts
PG_DB=qlts
FILES_DIR=/data/files
KEEP=14

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/../data_backups"
mkdir -p "$OUT_DIR"

TS="$(date +%Y%m%d_%H%M%S)"
DB_FILE="$OUT_DIR/qlts_db_$TS.dump"
FILES_FILE="$OUT_DIR/qlts_files_$TS.tgz"

echo "[backup] DB   -> $DB_FILE"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc "$PG_DB" > "$DB_FILE"

echo "[backup] File -> $FILES_FILE"
docker exec "$FILES_CONTAINER" tar czf - -C "$FILES_DIR" . > "$FILES_FILE"

# Chốt chặn backup rỗng/hỏng → không để dump lỗi âm thầm thay bản tốt.
for f in "$DB_FILE" "$FILES_FILE"; do
  if [ ! -s "$f" ]; then echo "[backup] LỖI: $f rỗng — hủy." >&2; exit 1; fi
done

echo "[backup] Xong: DB=$(du -h "$DB_FILE" | cut -f1)  File=$(du -h "$FILES_FILE" | cut -f1)"

# Xoay vòng: giữ KEEP bản mới nhất mỗi loại (xóa cũ hơn).
ls -1t "$OUT_DIR"/qlts_db_*.dump  2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
ls -1t "$OUT_DIR"/qlts_files_*.tgz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
