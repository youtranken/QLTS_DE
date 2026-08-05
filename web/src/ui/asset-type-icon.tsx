/**
 * Icon theo loại tài sản cho bảng /tai-san (làm đẹp: ô "Loại" có icon thay vì chữ trần).
 * Khớp theo giá trị catalog (Laptop/PC/monitor/Router/Máy in/software) — không phân biệt hoa
 * thường; loại lạ → icon "hộp" mặc định. Chỉ trình bày, không đổi dữ liệu.
 */
const P = {
  laptop: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M2 20h20" />
    </>
  ),
  pc: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="3" width="18" height="12" rx="2" />
      <path d="M7 20h10M12 15v5" />
    </>
  ),
  router: (
    <>
      <rect x="2" y="14" width="20" height="7" rx="2" />
      <path d="M6.5 17.5h.01M10 17.5h.01" />
      <path d="M8 10.5a5 5 0 0 1 8 0M5.5 7.5a9 9 0 0 1 13 0" />
    </>
  ),
  printer: (
    <>
      <path d="M6 9V3h12v6" />
      <rect x="6" y="14" width="12" height="7" rx="1" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2" />
    </>
  ),
  software: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  box: (
    <>
      <path d="M21 8 12 3 3 8l9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8" />
    </>
  ),
};

function pathFor(type: string) {
  const t = type.trim().toLowerCase();
  if (t.includes('laptop')) return P.laptop;
  if (t === 'pc' || t.includes('desktop')) return P.pc;
  if (t.includes('monitor') || t.includes('màn')) return P.monitor;
  if (t.includes('router') || t.includes('switch') || t.includes('mạng')) return P.router;
  if (t.includes('in') || t.includes('print')) return P.printer;
  if (t.includes('software') || t.includes('phần mềm')) return P.software;
  return P.box;
}

export function AssetTypeIcon({ type }: { type: string }) {
  return (
    <span className="type-ic" aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {pathFor(type)}
      </svg>
    </span>
  );
}
