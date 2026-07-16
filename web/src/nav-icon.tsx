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
      <path d="M21 8 12 3 3 8l9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8" />
    </>
  ),
  'nav.software': (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  'nav.pool': (
    <>
      <path d="m12 2 9 5v10l-9 5-9-5V7Z" />
      <path d="M12 12 3 7M12 12l9-5M12 12v10" />
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
      <path d="M20 12v8H4v-8" />
      <path d="M2 7h20v5H2z" />
      <path d="M12 22V7M12 7 8 3M12 7l4-4" />
    </>
  ),
  'nav.audit': (
    <>
      <path d="M12 8v4l3 2" />
      <path d="M3.05 11a9 9 0 1 1 .5 4" />
      <path d="M3 4v4h4" />
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
