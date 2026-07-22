/** Nhân vật trợ lý — robot SVG dễ thương (token app, trắng trên nền gradient FAB). */
export function Mascot() {
  return (
    <svg
      className="qc-mascot"
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="24" cy="7" r="2.5" fill="#fff" className="qc-antenna" />
      <line x1="24" y1="9" x2="24" y2="14" stroke="#fff" strokeWidth="2" />
      <rect x="9" y="14" width="30" height="23" rx="8" fill="#fff" />
      <rect x="4" y="22" width="3.5" height="8" rx="1.75" fill="#fff" />
      <rect x="40.5" y="22" width="3.5" height="8" rx="1.75" fill="#fff" />
      <circle cx="18.5" cy="24" r="3" fill="var(--primary-ink)" className="qc-eye" />
      <circle cx="29.5" cy="24" r="3" fill="var(--primary-ink)" className="qc-eye" />
      <path
        d="M18.5 30c1.6 1.8 9.4 1.8 11 0"
        stroke="var(--primary-ink)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
