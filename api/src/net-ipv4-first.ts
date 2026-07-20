// PMH ID allow-list theo IPv4 NGUỒN (client_id/secret gắn IP v4). Node 17+ mặc định DNS
// 'verbatim' → khi host có cả A (IPv4) lẫn AAAA (IPv6), egress có thể đi IPv6 (KHÔNG nằm trong
// allow-list) → PMH ID chặn token exchange / M2M. Ép ưu tiên IPv4 để connect từ IP đã allow-list.
// PHẢI import DÒNG ĐẦU ở mọi entry (main.ts, worker.ts) — chạy trước mọi module chạm mạng.
import { setDefaultResultOrder } from 'node:dns';

setDefaultResultOrder('ipv4first');
