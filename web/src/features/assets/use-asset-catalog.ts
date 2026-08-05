import { useCallback, useEffect, useState } from 'react';

/**
 * Danh mục Loại/Hãng/Cấu hình/Vị trí/Tên license (8.2) — nạp danh sách active để dropdown chọn
 * nhanh, kèm nút (+) thêm nhanh Cấu hình & Tên license ngay tại form (Loại/Hãng thêm ở trang
 * Danh mục). `configuration`/`licenseName` truyền vào để hàm thêm biết giá trị đang gõ.
 */
export function useAssetCatalog(
  csrfToken: string | null | undefined,
  configuration: string,
  licenseName: string,
) {
  const [catType, setCatType] = useState<string[]>([]);
  const [catBrand, setCatBrand] = useState<string[]>([]);
  const [catConfig, setCatConfig] = useState<string[]>([]);
  const [catPlace, setCatPlace] = useState<string[]>([]);
  const [catLicenseName, setCatLicenseName] = useState<string[]>([]);
  const [addingConfig, setAddingConfig] = useState(false);
  const [addingLicenseName, setAddingLicenseName] = useState(false);

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
    void load('licenseName', setCatLicenseName);
    return () => c.abort();
  }, []);

  // Thêm nhanh 1 giá trị vào danh mục ngay tại form (phụ trợ — lỗi KHÔNG chặn lưu tài sản).
  const addValue = useCallback(
    async (
      kind: string,
      raw: string,
      list: string[],
      setList: (fn: (l: string[]) => string[]) => void,
      setBusy: (v: boolean) => void,
    ) => {
      const v = raw.trim();
      if (!v || list.includes(v)) return;
      setBusy(true);
      try {
        const res = await fetch('/api/admin/catalog', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
          body: JSON.stringify({ kind, value: v }),
        });
        // 201 mới / 409 đã có (khác hoa-thường) → vẫn coi là có trong danh mục
        if (res.ok || res.status === 201 || res.status === 409) {
          setList((l) => (l.includes(v) ? l : [...l, v].sort()));
        }
      } catch {
        /* im lặng — thêm danh mục là phụ trợ, không chặn lưu tài sản */
      } finally {
        setBusy(false);
      }
    },
    [csrfToken],
  );

  const addConfig = useCallback(
    () =>
      addValue('configuration', configuration, catConfig, setCatConfig, setAddingConfig),
    [addValue, configuration, catConfig],
  );
  const addLicenseName = useCallback(
    () =>
      addValue(
        'licenseName',
        licenseName,
        catLicenseName,
        setCatLicenseName,
        setAddingLicenseName,
      ),
    [addValue, licenseName, catLicenseName],
  );

  return {
    catType,
    catBrand,
    catConfig,
    catPlace,
    catLicenseName,
    setCatConfig,
    addConfig,
    addingConfig,
    addLicenseName,
    addingLicenseName,
  };
}
