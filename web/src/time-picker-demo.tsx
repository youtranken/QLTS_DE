import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import '@/index.css';
import { TimePicker } from '@/time-picker';
import type { TimeValue } from '@/time-picker';
import { currentTheme, toggleTheme } from '@/theme';

// Trang demo tách riêng để duyệt TimePicker trong stack thật (React 19 + Vite + token QLTS).
function Demo() {
  const [theme, setTheme] = useState(currentTheme());
  const [picked, setPicked] = useState<TimeValue | null>(null);

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 32 }}>
      <button
        type="button"
        onClick={() => setTheme(toggleTheme())}
        style={{
          position: 'fixed',
          top: 16,
          right: 16,
          padding: '8px 14px',
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--ink)',
          font: 'inherit',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {theme === 'dark' ? '☀ Sáng' : '🌙 Tối'}
      </button>

      <div style={{ display: 'grid', gap: 16, justifyItems: 'center' }}>
        <TimePicker onDone={setPicked} />
        <p style={{ color: 'var(--ink-2)', fontSize: 14 }}>
          {picked
            ? `Đã chọn: ${String(picked.hour).padStart(2, '0')}:${String(picked.minute).padStart(2, '0')} ${picked.pm ? 'PM' : 'AM'}`
            : 'Bấm "Done" để xác nhận giờ đã chọn'}
        </p>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Demo />);
