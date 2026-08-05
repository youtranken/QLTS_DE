#!/usr/bin/env bash
# Restore dữ liệu QLTS từ 1 cặp backup (DB .dump + files .tgz).
# ⚠️ GHI ĐÈ toàn bộ dữ liệu hiện tại. Dừng api/worker → drop+tạo lại DB → pg_restore → bung file.
set -euo pipefail

# Git-Bash (Windows) tự đổi '/data/files' thành đường dẫn Windows → tắt đi. Vô hại trên Linux.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

# Chốt COMPOSE_PROJECT_NAME=qlts trong .env để container luôn 'qlts-*' dù thư mục clone tên khác.
PG_CONTAINER=${PG_CONTAINER:-qlts-postgres-1}
FILES_CONTAINER=${FILES_CONTAINER:-qlts-api-1}
PG_USER=qlts
PG_DB=qlts
FILES_DIR=/data/files

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/.."   # thư mục có docker-compose.yml

DB_FILE="${1:-}"
FILES_FILE="${2:-}"
if [ -z "$DB_FILE" ]; then
  echo "Dùng: $0 <qlts_db_*.dump> [qlts_files_*.tgz]" >&2
  echo "Các bản backup có sẵn (mới nhất trước):" >&2
  ls -1t "$SCRIPT_DIR/../data_backups"/qlts_db_*.dump 2>/dev/null >&2 || echo "  (chưa có)" >&2
  exit 1
fi
[ -s "$DB_FILE" ] || { echo "Không thấy/rỗng: $DB_FILE" >&2; exit 1; }

read -r -p "GHI ĐÈ database '$PG_DB' bằng '$DB_FILE'? Gõ 'yes' để tiếp: " ok
[ "$ok" = "yes" ] || { echo "Đã hủy."; exit 1; }

echo "[restore] Dừng api + worker (giải phóng kết nối DB)..."
docker compose -f "$PROJECT_DIR/docker-compose.yml" stop api worker

echo "[restore] Tạo lại database sạch..."
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $PG_DB WITH (FORCE);" \
  -c "CREATE DATABASE $PG_DB OWNER $PG_USER;"

echo "[restore] pg_restore..."
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$PG_DB" --no-owner < "$DB_FILE"

if [ -n "$FILES_FILE" ]; then
  [ -s "$FILES_FILE" ] || { echo "Không thấy/rỗng: $FILES_FILE" >&2; exit 1; }
  echo "[restore] Bung lại thư mục file..."
  docker exec -i "$FILES_CONTAINER" sh -c "rm -rf $FILES_DIR/* && tar xzf - -C $FILES_DIR" < "$FILES_FILE"
fi

echo "[restore] Khởi động lại api + worker..."
docker compose -f "$PROJECT_DIR/docker-compose.yml" start api worker
echo "[restore] Xong."
