import { useEffect, useRef, useState } from 'react';
import '@/ui/time-picker.css';

const ITEM_H = 42; // px — khớp --item-h trong CSS
const ANGLE = 22; // độ nghiêng mỗi item → cảm giác mặt trống

const ClockIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
const SunIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4" />
  </svg>
);

interface WheelProps {
  count: number;
  render: (i: number) => string;
  value: number;
  onChange: (i: number) => void;
  ariaLabel: string;
}

/** Một cột bánh xe: cuộn native + scroll-snap lo đà/quán tính; JS chỉ tô 3D theo scrollTop. */
function Wheel({ count, render, value, onChange, ariaLabel }: WheelProps) {
  const colRef = useRef<HTMLDivElement>(null);
  const emitted = useRef(value); // chặn vòng lặp scrollTo ⇄ onChange
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const col = colRef.current!;
    const cells = Array.from(col.querySelectorAll<HTMLElement>('.tp-cell'));
    const clamp = (v: number) => (v < 0 ? 0 : v > count - 1 ? count - 1 : v);
    const glide = (i: number) => col.scrollTo({ top: clamp(i) * ITEM_H, behavior: 'smooth' });

    const paint = () => {
      const center = col.scrollTop / ITEM_H;
      const sel = Math.round(center);
      cells.forEach((c, i) => {
        const off = i - center;
        const a = Math.abs(off);
        // Ô xa (nhất là cột phút 60 ô) vốn bị mask che → chỉ ẩn, KHÔNG tính lại transform mỗi
        // frame → giảm việc/khung, cuộn mượt hơn.
        if (a > 4) {
          if (c.style.opacity !== '0') c.style.opacity = '0';
          if (c.classList.contains('on')) c.classList.remove('on');
          return;
        }
        c.style.opacity = String(Math.max(0, 1 - a * 0.26));
        c.style.transform = `perspective(650px) rotateX(${off * -ANGLE}deg) scale(${Math.max(0.82, 1 - a * 0.05)})`;
        c.classList.toggle('on', i === sel);
      });
      if (sel !== emitted.current && sel >= 0 && sel < count) {
        emitted.current = sel;
        onChangeRef.current(sel);
      }
    };

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        paint();
        ticking = false;
      });
    };

    // Kéo bằng chuột (cảm ứng đã có cuộn native). Thả tay → "ném" theo vận tốc rồi snap.
    let dragging = false;
    let moved = false;
    let startY = 0;
    let startScroll = 0;
    let lastY = 0;
    let lastT = 0;
    let vY = 0;
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      col.style.scrollSnapType = 'none'; // tắt snap khi kéo tay → không giằng, theo sát con trỏ
      dragging = true;
      moved = false;
      startY = lastY = e.clientY;
      lastT = e.timeStamp;
      startScroll = col.scrollTop;
      vY = 0;
      col.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 3) moved = true;
      col.scrollTop = startScroll - dy;
      const dt = e.timeStamp - lastT;
      if (dt > 0) vY = (e.clientY - lastY) / dt;
      lastY = e.clientY;
      lastT = e.timeStamp;
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      glide(Math.round((col.scrollTop - vY * 130) / ITEM_H)); // "ném" theo vận tốc rồi trượt tới
      window.setTimeout(() => (col.style.scrollSnapType = ''), 380); // bật lại snap sau khi trượt xong
    };
    const click = (e: MouseEvent) => {
      if (moved) return;
      const c = (e.target as HTMLElement).closest<HTMLElement>('.tp-cell');
      if (c) glide(Number(c.dataset.i));
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        glide(Math.round(col.scrollTop / ITEM_H) - 1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        glide(Math.round(col.scrollTop / ITEM_H) + 1);
      }
    };

    col.addEventListener('scroll', onScroll, { passive: true });
    col.addEventListener('pointerdown', down);
    col.addEventListener('pointermove', move);
    col.addEventListener('pointerup', up);
    col.addEventListener('pointercancel', up);
    col.addEventListener('click', click);
    col.addEventListener('keydown', key);

    col.scrollTop = value * ITEM_H;
    paint();

    return () => {
      col.removeEventListener('scroll', onScroll);
      col.removeEventListener('pointerdown', down);
      col.removeEventListener('pointermove', move);
      col.removeEventListener('pointerup', up);
      col.removeEventListener('pointercancel', up);
      col.removeEventListener('click', click);
      col.removeEventListener('keydown', key);
    };
    // Gắn 1 lần; value ban đầu chỉ dùng để đặt vị trí, thay đổi sau xử lý ở effect dưới.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  // value đổi từ ngoài (Now/Cancel) → cuộn tới, bỏ qua nếu đã ở đúng vị trí (tránh lặp).
  useEffect(() => {
    const col = colRef.current!;
    if (Math.round(col.scrollTop / ITEM_H) === value) return;
    emitted.current = value;
    col.scrollTo({ top: value * ITEM_H, behavior: 'smooth' });
  }, [value]);

  return (
    <div
      className="tp-col"
      ref={colRef}
      tabIndex={0}
      role="spinbutton"
      aria-label={ariaLabel}
      aria-valuenow={value}
    >
      <div className="tp-list">
        {Array.from({ length: count }, (_, i) => (
          <div className="tp-cell" key={i} data-i={i}>
            {render(i)}
          </div>
        ))}
      </div>
    </div>
  );
}

export interface TimeValue {
  hour: number; // 1..12
  minute: number; // 0..59
  pm: boolean;
}

interface TimePickerProps {
  value?: TimeValue;
  onDone?: (v: TimeValue) => void;
  onCancel?: () => void;
}

const pad = (n: number) => String(n).padStart(2, '0');
const DEFAULT: TimeValue = { hour: 8, minute: 6, pm: true };

export function TimePicker({ value = DEFAULT, onDone, onCancel }: TimePickerProps) {
  const [h, setH] = useState(value.hour - 1); // index 0..11
  const [m, setM] = useState(value.minute);
  const [pm, setPm] = useState(value.pm);
  const fieldRef = useRef<HTMLDivElement>(null);

  // Nhập giờ TRỰC TIẾP (gõ "HH:MM" 12h) — đồng bộ 2 chiều với bánh xe. Khi đang gõ thì không
  // để bánh xe ghi đè ô; blur thì chuẩn hóa lại theo h/m hiện tại.
  const [text, setText] = useState(`${pad(h + 1)}:${pad(m)}`);
  const editingRef = useRef(false);
  useEffect(() => {
    if (!editingRef.current) setText(`${pad(h + 1)}:${pad(m)}`);
  }, [h, m]);
  const onTextChange = (v: string) => {
    setText(v);
    const mt = v.match(/^(\d{1,2}):(\d{1,2})$/);
    if (mt) {
      const H = Number(mt[1]);
      const M = Number(mt[2]);
      if (H >= 1 && H <= 12 && M >= 0 && M <= 59) {
        setH(H - 1);
        setM(M);
      }
    }
  };

  const now = () => {
    const d = new Date();
    setPm(d.getHours() >= 12);
    setH(((d.getHours() + 11) % 12)); // 0..11 cho 1..12
    setM(d.getMinutes());
  };
  const reset = () => {
    setH(value.hour - 1);
    setM(value.minute);
    setPm(value.pm);
    onCancel?.();
  };
  const done = () => {
    fieldRef.current?.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.03)' }, { transform: 'scale(1)' }],
      { duration: 260, easing: 'ease-out' },
    );
    onDone?.({ hour: h + 1, minute: m, pm });
  };

  return (
    <section className="tp" aria-label="Chọn giờ">
      <p className="tp-title">Select Time</p>

      <div className="tp-field" ref={fieldRef}>
        <ClockIcon />
        <input
          className="tp-time"
          value={text}
          inputMode="numeric"
          maxLength={5}
          aria-label="Giờ : phút"
          onFocus={() => {
            editingRef.current = true;
          }}
          onBlur={() => {
            editingRef.current = false;
            setText(`${pad(h + 1)}:${pad(m)}`);
          }}
          onChange={(e) => onTextChange(e.target.value)}
        />
        <span className="tp-mer-chip">{pm ? 'PM' : 'AM'}</span>
      </div>

      <div className="tp-seg">
        <button type="button" className="on">
          <ClockIcon />
          Time
        </button>
        <button type="button" onClick={now}>
          <SunIcon />
          Now
        </button>
      </div>

      <div className="tp-body">
        <div className="tp-wheels">
          <Wheel count={12} render={(i) => pad(i + 1)} value={h} onChange={setH} ariaLabel="Giờ" />
          <span className="tp-sep">:</span>
          <Wheel count={60} render={(i) => pad(i)} value={m} onChange={setM} ariaLabel="Phút" />
          <div className="tp-band" aria-hidden="true" />
        </div>
        <div className="tp-mer">
          <button type="button" className={pm ? '' : 'on'} onClick={() => setPm(false)}>
            AM
          </button>
          <button type="button" className={pm ? 'on' : ''} onClick={() => setPm(true)}>
            PM
          </button>
        </div>
      </div>

      <div className="tp-actions">
        <button type="button" className="ghost" onClick={reset}>
          Cancel
        </button>
        <button type="button" className="solid" onClick={done}>
          Done
        </button>
      </div>
    </section>
  );
}
