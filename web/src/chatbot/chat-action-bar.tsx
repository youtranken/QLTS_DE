import type { JSX } from 'react';
import { menuFor, type Chip } from '@/chatbot/chat-types';

const S = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** Icon SVG theo intent — đồng bộ phong cách line-icon của app. */
const ICONS: Record<string, JSX.Element> = {
  list_types: (
    <svg viewBox="0 0 24 24" {...S}>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  my_assets: (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
  my_borrowings: (
    <svg viewBox="0 0 24 24" {...S}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  ),
  availability: (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  pending_approvals: (
    <svg viewBox="0 0 24 24" {...S}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
};

/** Thanh hành động cố định trên ô nhập — nội dung theo vai (member mượn máy / admin tra cứu). */
export function ChatActionBar({
  role,
  onPick,
  disabled = false,
}: {
  role: string;
  onPick: (chip: Chip) => void;
  disabled?: boolean;
}) {
  return (
    <div className="qc-actionbar">
      {menuFor(role).map((c) => (
        <button
          key={c.action.intent}
          type="button"
          className="qc-abtn"
          disabled={disabled}
          onClick={() => onPick(c)}
        >
          {ICONS[c.action.intent]}
          {c.label}
        </button>
      ))}
    </div>
  );
}
