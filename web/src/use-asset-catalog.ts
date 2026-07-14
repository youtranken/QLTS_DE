import { useCallback, useEffect, useState } from 'react';

/**
 * Danh mục Loại/Hãng/Cấu hình/Vị trí (8.2) — nạp danh sách active để dropdown chọn nhanh,
 * kèm nút (+) thêm nhanh Cấu hình ngay tại form (Loại/Hãng thêm ở trang Danh mục).
 * `configuration` truyền vào để addConfig biết giá trị đang gõ mà không cần giữ form ở đây.
 */
export function useAssetCatalog(
  csrfToken: string | null | undefined,
  configuration: string,
) {
  const [catType, setCatType] = useState<string[]>([]);
  const [catBrand, setCatBrand] = useState<string[]>([]);
  const [catConfig, setCatConfig] = useState<string[]>([]);
  const [catPlace, setCatPlace] = useState<string[]>([]);
  const [addingConfig, setAddingConfig] = useState(false);

  useEffect(() => {
    const c = new AbortController();
    const load = (kind: string, set: (v: string[]) => void) =>
      fetch(`/api/admin/catalog?kind=${kind}&activeOnly=true`, {
        signal: c.signal,
      })
        .then((r) => (r.ok ? (r.json() as Promise<Array<{ value: string }>>) : []))
        .then((rows) => set(rows.map((x) => x.value)))
        .catch(() => undefined);
    void load('type', setCatType);
    void load('brand', setCatBrand);
    void load('configuration', setCatConfig);
    void load('place', setCatPlace);
    return () => c.abort();
  }, []);

  const addConfig = useCallback(async () => {
    const v = configuration.trim();
    if (!v || catConfig.includes(v)) return;
    setAddingConfig(true);
    try {
      const res = await fetch('/api/admin/catalog', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        body: JSON.stringify({ kind: 'configuration', value: v }),
      });
      // 201 mới / 409 đã có (khác hoa-thường) → vẫn coi là có trong danh mục
      if (res.ok || res.status === 201 || res.status === 409) {
        setCatConfig((l) => (l.includes(v) ? l : [...l, v].sort()));
      }
    } catch {
      /* im lặng — thêm danh mục là phụ trợ, không chặn lưu tài sản */
    } finally {
      setAddingConfig(false);
    }
  }, [configuration, catConfig, csrfToken]);

  return {
    catType,
    catBrand,
    catConfig,
    catPlace,
    setCatConfig,
    addConfig,
    addingConfig,
  };
}
