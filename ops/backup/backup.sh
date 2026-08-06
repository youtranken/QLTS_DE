#!/usr/bin/env sh
# Backup QLTS: pg_dump + tar thư mục file upload → gzip (mã hóa nếu có BACKUP_PASSPHRASE),
# giữ TỊNH TIẾN theo NGÀY. Chạy trong container (có sẵn pg_dump). Mô phỏng backup PMH ID.
#
#   docker compose -f docker-compose.yml --profile backup run --rm backup   # chạy tay 1 bản
#   (service backup-cron tự chạy hằng ngày lúc BACKUP_AT)
set -eu
set -o pipefail 2>/dev/null || true

: "${POSTGRES_USER:?thiếu POSTGRES_USER}"
: "${POSTGRES_PASSWORD:?thiếu POSTGRES_PASSWORD}"
: "${POSTGRES_DB:?thiếu POSTGRES_DB}"
PGHOST="${PGHOST:-postgres}"
OUT_DIR="${BACKUP_OUT:-/backups}"
FILES_DIR="${FILES_DIR:-/data/files}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"

case "$KEEP_DAYS" in ''|*[!0-9]*) echo "BACKUP_KEEP_DAYS không hợp lệ: $KEEP_DAYS"; exit 1;; esac
[ "$KEEP_DAYS" -ge 1 ] || { echo "BACKUP_KEEP_DAYS phải >=1 (đang $KEEP_DAYS)"; exit 1; }
command -v pg_dump >/dev/null || { echo "thiếu pg_dump"; exit 1; }

# Chốt mã hóa (fail-closed): mặc định TỪ CHỐI backup không mã hóa để không lộ dump âm thầm.
# Rỗng → phải cố ý BACKUP_ALLOW_PLAINTEXT=1; chặn placeholder .env.example và passphrase quá ngắn.
PASS="${BACKUP_PASSPHRASE:-}"
if [ -n "$PASS" ]; then
  [ "$PASS" != "CHANGE_ME_openssl_rand_hex_32" ] || {
    echo "[qlts-backup] LỖI: BACKUP_PASSPHRASE còn là placeholder — đổi bằng 'openssl rand -hex 32'." >&2; exit 1; }
  [ "${#PASS}" -ge 16 ] || {
    echo "[qlts-backup] LỖI: BACKUP_PASSPHRASE quá ngắn (${#PASS} ký tự, cần >=16)." >&2; exit 1; }
elif [ "${BACKUP_ALLOW_PLAINTEXT:-0}" != "1" ]; then
  echo "[qlts-backup] LỖI: chưa đặt BACKUP_PASSPHRASE → từ chối backup KHÔNG mã hóa." >&2
  echo "  Sinh khóa: openssl rand -hex 32  → gán BACKUP_PASSPHRASE trong .env" >&2
  echo "  (Cố ý muốn plaintext thì đặt BACKUP_ALLOW_PLAINTEXT=1)" >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR" "$WORK/bundle"

export PGPASSWORD="$POSTGRES_PASSWORD"
echo "[qlts-backup] pg_dump…"
pg_dump -h "$PGHOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges > "$WORK/bundle/db.sql"

if [ -d "$FILES_DIR" ]; then
  echo "[qlts-backup] gom file upload ($FILES_DIR)…"
  cp -r "$FILES_DIR" "$WORK/bundle/files"
else
  echo "[qlts-backup] (chưa có thư mục file $FILES_DIR — bỏ qua)"
fi

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  command -v openssl >/dev/null || { echo "cần openssl để mã hóa"; exit 1; }
  OUT="$OUT_DIR/qlts-backup-$STAMP.tar.gz.enc"
  echo "[qlts-backup] tar + mã hóa AES-256 → $OUT"
  ( umask 077; tar -czf - -C "$WORK/bundle" . | \
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -out "$OUT" )
else
  OUT="$OUT_DIR/qlts-backup-$STAMP.tar.gz"
  echo "[qlts-backup] ⚠ tar KHÔNG mã hóa (BACKUP_ALLOW_PLAINTEXT=1) → $OUT"
  ( umask 077; tar -czf "$OUT" -C "$WORK/bundle" . )
fi
chmod 600 "$OUT"

echo "[qlts-backup] tịnh tiến: xóa bản cũ hơn $KEEP_DAYS ngày"
find "$OUT_DIR" -maxdepth 1 -name 'qlts-backup-*.tar.gz*' -type f -mtime "+$KEEP_DAYS" -print -exec rm -f {} \;

echo "[qlts-backup] XONG: $OUT"
