#!/usr/bin/env sh
# Hẹn giờ backup QLTS CHẠY TRONG CONTAINER (không phụ thuộc cron host). Giống PMH ID.
# Vòng lặp: tính giây tới mốc BACKUP_AT kế tiếp → ngủ → chạy backup.sh → lặp.
#   BACKUP_AT=HH:MM (mặc định 02:00, giờ container = TZ)
set -u

AT="${BACKUP_AT:-02:00}"
case "$AT" in
  [0-2][0-9]:[0-5][0-9]) ;;
  *) echo "[qlts-backup-cron] BACKUP_AT không hợp lệ: '$AT' (cần HH:MM)"; exit 1 ;;
esac
HH=${AT%:*}
MM=${AT#*:}
[ "$HH" -le 23 ] || { echo "[qlts-backup-cron] giờ không hợp lệ: $HH"; exit 1; }

echo "[qlts-backup-cron] khởi động — mốc chạy hằng ngày $AT (TZ=${TZ:-UTC})"

while :; do
  now=$(date +%s)
  today=$(date +%Y-%m-%d)
  target=$(date -d "$today $HH:$MM" +%s 2>/dev/null) || {
    echo "[qlts-backup-cron] date -d không dùng được trên image này"; exit 1; }
  [ "$target" -le "$now" ] && target=$((target + 86400))
  sleep_for=$((target - now))
  echo "[qlts-backup-cron] chờ ${sleep_for}s → $(date -d "@$target" '+%Y-%m-%d %H:%M:%S')"
  sleep "$sleep_for"

  echo "[qlts-backup-cron] === chạy backup $(date '+%Y-%m-%d %H:%M:%S') ==="
  if sh /backup.sh; then
    echo "[qlts-backup-cron] backup XONG"
  else
    echo "[qlts-backup-cron] backup LỖI (mã $?) — giữ lịch, thử lại mốc kế tiếp"
  fi
  sleep 60
done
