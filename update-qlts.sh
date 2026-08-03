#!/usr/bin/env bash
# update-qlts — cập nhật QLTS lên code mới nhất trên GitHub.
# git pull (ff-only) → rebuild + recreate (api tự chạy migration lúc boot) → chờ health.
# Chạy:  bash ~/QLTS_DE/update-qlts.sh
set -euo pipefail

QLTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # script nằm ở gốc QLTS_DE
cd "$QLTS"

echo "==> [1/3] Kiểm repo sạch rồi kéo code mới (ff-only)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "!! ${QLTS} có thay đổi cục bộ chưa commit — dừng. Xem: git -C ${QLTS} status" >&2
  exit 1
fi
git pull --ff-only

echo "==> [2/3] Build + recreate (prod chỉ -f docker-compose.yml, KHÔNG nạp override dev)"
docker compose -f docker-compose.yml up -d --build

echo "==> [3/3] Chờ /api/health (qua edge cổng 8443)"
ok=0
for i in $(seq 1 30); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' -H 'Host: qlts.pmh.com.vn' https://localhost:8443/api/health || true)
  [[ "$code" == "200" ]] && { ok=1; echo "    health OK (200)"; break; }
  echo "    ...chờ (HTTP ${code:-x}) ${i}/30"; sleep 3
done
echo
docker compose -f docker-compose.yml ps
[[ "$ok" == 1 ]] || { echo "!! Chưa lên 200 — xem log: cd ${QLTS} && docker compose -f docker-compose.yml logs -f api" >&2; exit 1; }
echo "XONG update QLTS. (Migration mới nếu có đã chạy lúc api boot.)"
