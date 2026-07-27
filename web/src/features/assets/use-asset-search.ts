import { useEffect, useState } from 'react';

/**
 * Ô tìm kiếm server-side có debounce — dùng lại cho 3 combobox của form tài sản
 * (người đứng tên, máy chủ để cài, phần mềm để gắn). Users/assets có thể hàng nghìn
 * bản ghi nên không tải hết, gõ tới đâu tìm tới đó.
 *
 * `buildUrl(q)` trả URL (hoặc null = tắt, xoá kết quả); `extract` bóc mảng từ response.
 * `extraDeps` = các giá trị NGOÀI query mà buildUrl/extract phụ thuộc (vd id máy đang gắn
 * để loại chính nó) — thay đổi thì tìm lại. `setOptions` được trả ra để caller xoá thủ công
 * sau khi chọn/gắn xong.
 */
export function useDebouncedSearch<T>(
  buildUrl: (q: string) => string | null,
  extract: (body: unknown) => T[],
  extraDeps: unknown[] = [],
  delay = 300,
) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<T[]>([]);
  useEffect(() => {
    const url = query ? buildUrl(query) : null;
    if (!url) {
      setOptions([]);
      return;
    }
    const c = new AbortController();
    const timer = setTimeout(() => {
      fetch(url, { signal: c.signal })
        .then(async (res) => {
          if (!res.ok) return;
          setOptions(extract(await res.json()));
        })
        .catch(() => undefined);
    }, delay);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
    // buildUrl/extract là closure tạo mới mỗi render — cố ý loại khỏi deps, chỉ chạy lại
    // theo query + extraDeps (đúng như 3 effect gốc trước khi gộp).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, ...extraDeps]);
  return { query, setQuery, options, setOptions };
}
