/**
 * fetch JSON, NÉM lỗi kèm status khi !ok — để caller phân biệt "lỗi" với "danh sách rỗng"
 * (review P0: nhiều màn nuốt lỗi thành 0/"…"). Mầm cho API client dùng chung (nguyên tắc #2).
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}`) as Error & { status?: number };
    e.status = r.status;
    throw e;
  }
  return (await r.json()) as T;
}
