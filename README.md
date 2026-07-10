# QLTS — Hệ thống Quản Lý Tài Sản

Monorepo: `api/` (NestJS 11, Node 24) + `web/` (React 19.2 / Vite 8, serve qua nginx) + PostgreSQL 18 + Redis 8, chạy bằng Docker Compose.

## Chạy bằng một lệnh

Yêu cầu: Docker (Desktop) có Compose v2.

```bash
cp .env.example .env   # đổi các giá trị CHANGE_ME
docker compose up --build
```

- Web: https://qlts.pmh.com.vn (nginx phục vụ TLS bằng cert `*.pmh.com.vn`; port 80 redirect → 443)
- API health: https://qlts.pmh.com.vn/api/health
- Cert (`fullchain.pem` + `private.key`) mount từ `../pmh.com.vn` vào `/etc/nginx/ssl` (không bake vào image)
- `qlts.pmh.com.vn` phải phân giải về host chạy Docker (DNS thật hoặc thêm hosts nếu test cục bộ)
- Migration trong `api/src/migrations/` tự chạy khi `api` khởi động (raw SQL, có thứ tự).
- `postgres`/`redis` **không** publish cổng ra host; mọi truy cập đi qua nginx (`web`).
- RAM: tổng ngân sách 2GB, `mem_limit` từng service chỉnh trong `.env`.

## Cấu trúc

```
qlts/
  api/                  # NestJS — modular monolith
    src/modules/        # auth, users, assets, pool, booking, tickets, notifications, reports, audit, config
    src/migrations/     # *.sql chạy theo thứ tự tên file (AD-12)
  web/                  # React SPA + nginx (proxy /api → api:3000)
  docker-compose.yml
```

## Dev & test (ngoài Docker)

```bash
cd api
npm install
npm test          # unit
npm run test:e2e  # e2e (không cần DB)
npm run test:db   # integration DB thật — cần DATABASE_URL
npm run lint
```

Test DB dùng CHUNG một Postgres với dev (không container test riêng): db-spec chạy trên
database `qlts_test` NẰM TRONG `qlts-postgres-1`. Mỗi suite `DROP TABLE ... CASCADE` rồi migrate
lại — chốt chặn `if (!/test/i.test(dbName)) throw` bảo đảm KHÔNG bao giờ đụng database `qlts`.
`docker-compose.override.yml` (dev-only) expose port 54329→postgres, 63799→redis ra host.

```bash
# 1 lần: tạo database test trong container postgres đang chạy
docker exec qlts-postgres-1 psql -U qlts -d qlts -c "CREATE DATABASE qlts_test OWNER qlts;"
# chạy (bash)
DATABASE_URL=postgresql://qlts:qlts_dev_pg_2026@localhost:54329/qlts_test \
REDIS_TEST_URL=redis://:qlts_dev_redis_2026@localhost:63799 npm run test:db
```

(PowerShell: `$env:DATABASE_URL='postgresql://qlts:qlts_dev_pg_2026@localhost:54329/qlts_test'; $env:REDIS_TEST_URL='redis://:qlts_dev_redis_2026@localhost:63799'; npm run test:db`)

## AUTH_DEV_MODE (seam test — AC 9 story 1.1)

`AUTH_DEV_MODE=true` cho phép giả định danh qua header `x-dev-user-sub` + `x-dev-role` (`member|admin|sa`).
Chỉ hoạt động khi `NODE_ENV ∈ {development, test}` — bật ở môi trường khác thì app **từ chối khởi động**.

## Convention migration (AD-12)

- File `api/src/migrations/NNNN_<mô-tả>.sql` (zero-pad 4 số), chạy theo thứ tự tên, mỗi file MỘT transaction, journal + checksum ở bảng `_migrations` — file đã áp mà bị sửa nội dung là boot fail (chống schema drift).
- **CẤM** `BEGIN`/`COMMIT` nội bộ trong file SQL (phá transaction wrapper của runner).
- Bất biến nghiệp vụ enforce ở TẦNG DB: `UNIQUE`/`CHECK` (0009/0012/0015), bảng sổ-vết dùng trigger append-only theo mẫu 0005 (`audit_log` → 0011 `allocation_history` → 0014 `asset_note`).
- Migration cần `CREATE INDEX CONCURRENTLY` (không chạy được trong transaction) hiện CHƯA hỗ trợ — cần marker opt-out trước story 3.1a (xem deferred-work).
