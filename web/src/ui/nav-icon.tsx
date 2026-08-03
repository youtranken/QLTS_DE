/**
 * Icon cho từng mục sidebar (theo key i18n) — làm shell giống app-shell.html.
 * Key lạ → icon chấm tròn mặc định. Chỉ trình bày.
 */
const ICONS: Record<string, React.ReactNode> = {
  'nav.lending': (
    <>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </>
  ),
  'nav.calendar': (
    <>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M8 2v4M16 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01" />
    </>
  ),
  'nav.assets': (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  'nav.software': (
    <>
      {/* Key — chìa/khoá license: phần mềm là license gán vào một tài sản. */}
      <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L21 4" />
      <path d="m21 2-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
    </>
  ),
  'nav.pool': (
    <>
      <path d="m12 2 9 5v10l-9 5-9-5V7Z" />
      <path d="M12 12 3 7M12 12l9-5M12 12v10" />
    </>
  ),
  'nav.eol': (
    <>
      {/* Tam giác cảnh báo — "Cảnh báo EOL" (máy đủ tuổi / license sắp hết hạn). */}
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  'nav.disposed': (
    <>
      <path d="M3 6h18" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  'nav.admin': (
    <>
      <path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  'nav.catalog': (
    <>
      {/* Tags (nhãn phân loại) — hợp "Danh mục" (Loại/Hãng/Cấu hình) hơn hình hộp cũ. */}
      <path d="m15 5 6.3 6.3a2.4 2.4 0 0 1 0 3.4L17 19" />
      <path d="M9.586 5.586A2 2 0 0 0 8.172 5H3a1 1 0 0 0-1 1v5.172a2 2 0 0 0 .586 1.414L8.29 18.29a2.426 2.426 0 0 0 3.42 0l3.58-3.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="6.5" cy="9.5" r="1.1" />
    </>
  ),
  'nav.audit': (
    <>
      <path d="M12 8v4l3 2" />
      <path d="M3.05 11a9 9 0 1 1 .5 4" />
      <path d="M3 4v4h4" />
    </>
  ),
  'nav.notifications': (
    <>
      {/* Chuông có chấm cảnh báo — "Thông báo lỗi" (thông báo gửi lỗi cần xử lý/gửi lại). */}
      <path d="M19.4 14.9C20.2 16.4 21 17 21 17H3s3-2 3-9c0-.7.1-1.4.3-2" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      <circle cx="18" cy="5" r="3" />
    </>
  ),
  'nav.mailSettings': (
    <>
      {/* Phong bì — "Cấu hình thông báo" (bật/tắt email theo sự kiện). */}
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  'nav.config': (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 9 3.6h.1A1.6 1.6 0 0 0 11 1.1V1a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 17 3.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V15z" />
    </>
  ),
};

export function NavIcon({ navKey }: { navKey: string }) {
  return (
    <svg
      className="nav-ic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[navKey] ?? <circle cx="12" cy="12" r="4" />}
    </svg>
  );
}
