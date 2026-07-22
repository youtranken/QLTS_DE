import type { JSX } from 'react';
import { MENU_CHIPS, type Chip } from './chat-types';

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
  availability: (
    <svg viewBox="0 0 24 24" {...S}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
};

/** Thanh hành động cố định trên ô nhập — luôn hiển thị (thay cho "Về đầu"). */
export function ChatActionBar({ onPick }: { onPick: (chip: Chip) => void }) {
  return (
    <div className="qc-actionbar">
      {MENU_CHIPS.map((c) => (
        <button
          key={c.action.intent}
          type="button"
          className="qc-abtn"
          onClick={() => onPick(c)}
        >
          {ICONS[c.action.intent]}
          {c.label}
        </button>
      ))}
    </div>
  );
}
