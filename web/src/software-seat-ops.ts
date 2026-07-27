import type { AssetDetail } from '@/asset-types';

/**
 * Thao tác 1 bản (seat) phần mềm KHÔNG dính React — dùng ở /phan-mem (expand) + nơi khác.
 * Đều tự lấy version tươi (list không trả version) rồi optimistic-lock. Trả {ok, message}.
 */
type Result = { ok: boolean; message?: string };

async function freshVersion(id: string): Promise<number | null> {
  const res = await fetch(`/api/admin/assets/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return ((await res.json()) as AssetDetail).version;
}

function headers(csrfToken: string | null | undefined) {
  return {
    'Content-Type': 'application/json',
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
  };
}

async function message(res: Response): Promise<string | undefined> {
  const b = (await res.json().catch(() => null)) as { message?: string } | null;
  return b?.message;
}

/** Gỡ bản khỏi máy (giữ ghế trống): PUT :id/transfer chỉ với version (không targetAssetId). */
export async function detachSeat(
  id: string,
  csrfToken: string | null | undefined,
): Promise<Result> {
  try {
    const version = await freshVersion(id);
    if (version == null) return { ok: false };
    const res = await fetch(
      `/api/admin/assets/${encodeURIComponent(id)}/transfer`,
      { method: 'PUT', headers: headers(csrfToken), body: JSON.stringify({ version }) },
    );
    return res.ok ? { ok: true } : { ok: false, message: await message(res) };
  } catch {
    return { ok: false };
  }
}

/** Thanh lý bản (→ Kho thanh lý): POST :id/dispose với version. */
export async function disposeSeat(
  id: string,
  csrfToken: string | null | undefined,
): Promise<Result> {
  try {
    const version = await freshVersion(id);
    if (version == null) return { ok: false };
    const res = await fetch(
      `/api/admin/assets/${encodeURIComponent(id)}/dispose`,
      { method: 'POST', headers: headers(csrfToken), body: JSON.stringify({ version }) },
    );
    return res.ok ? { ok: true } : { ok: false, message: await message(res) };
  } catch {
    return { ok: false };
  }
}
