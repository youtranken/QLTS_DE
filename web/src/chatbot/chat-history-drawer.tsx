import { useCallback, useEffect, useState } from 'react';
import type { ConversationSummary } from './chat-types';

const DAY = 86400000;

function dayGroup(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (t >= startToday) return 'Hôm nay';
  if (t >= startToday - DAY) return 'Hôm qua';
  return 'Trước đó';
}

const GROUPS = ['Hôm nay', 'Hôm qua', 'Trước đó'];

/** Drawer lịch sử — danh sách cuộc của member; chọn/xoá/tạo mới. */
export function ChatHistoryDrawer({
  open,
  onClose,
  list,
  onSelect,
  onDelete,
  onNew,
}: {
  open: boolean;
  onClose: () => void;
  list: () => Promise<ConversationSummary[]>;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onNew: () => void;
}) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const refresh = useCallback(async () => {
    try {
      setItems(await list());
    } catch {
      setItems([]);
    }
  }, [list]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const del = async (id: string) => {
    await onDelete(id);
    await refresh();
  };

  const grouped = GROUPS.map((g) => ({
    g,
    rows: items.filter((i) => dayGroup(i.updated_at) === g),
  })).filter((x) => x.rows.length > 0);

  return (
    <div className={`qc-drawer${open ? ' qc-open' : ''}`}>
      <div className="qc-drawer-head">
        <button
          type="button"
          className="qc-iconbtn"
          onClick={onClose}
          aria-label="Đóng lịch sử"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="qc-dt">Lịch sử trò chuyện</span>
      </div>
      <button type="button" className="qc-newchat" onClick={onNew}>
        ＋ Trò chuyện mới
      </button>
      <div className="qc-hist">
        {items.length === 0 && (
          <div className="qc-hist-empty">Chưa có cuộc trò chuyện nào.</div>
        )}
        {grouped.map(({ g, rows }) => (
          <div key={g}>
            <div className="qc-hist-label">{g}</div>
            {rows.map((r) => (
              <div key={r.id} className="qc-hist-item">
                <button
                  type="button"
                  className="qc-ht"
                  onClick={() => onSelect(r.id)}
                >
                  {r.title || 'Cuộc trò chuyện'}
                </button>
                <button
                  type="button"
                  className="qc-hist-del"
                  aria-label="Xoá cuộc trò chuyện"
                  onClick={() => void del(r.id)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
