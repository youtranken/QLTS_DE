/**
 * Tải file từ 1 endpoint (kèm cookie) và ÉP tên file đúng.
 *
 * Vì sao không dùng `<a href download>` thẳng: khi điều hướng tới response
 * `application/octet-stream`, một số trình duyệt bỏ qua tên trong Content-Disposition
 * và đặt tên hash (vd "f01df85…") không có đuôi .xlsx. Fetch → blob → a.download giữ
 * đúng tên (ưu tiên tên server gửi, fallback tên truyền vào) trên mọi trình duyệt.
 */
export async function downloadFile(
  url: string,
  fallbackName: string,
): Promise<void> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^"();]+)"?/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const objUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
}
