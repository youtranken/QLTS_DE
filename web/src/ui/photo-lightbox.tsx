import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface LightboxImage {
  url: string;
  label?: string;
}

/**
 * UP-5.5: lightbox xem ảnh biên bản giao/nhận. ‹ › / Esc / bấm nền để đóng, đếm n/total.
 * Ảnh serve inline (Content-Type image/*) từ endpoint ticket-photo nên render thẳng <img>.
 */
export function PhotoLightbox({
  images,
  startIndex = 0,
  onClose,
}: {
  images: LightboxImage[];
  startIndex?: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [cur, setCur] = useState(startIndex);

  const go = useCallback(
    (d: number) => setCur((c) => (c + d + images.length) % images.length),
    [images.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go, onClose]);

  if (images.length === 0) return null;
  const img = images[cur];

  return (
    <div
      className="lightbox open"
      role="dialog"
      aria-modal="true"
      aria-label={t('lightbox.title')}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="lb-stage">
        <button
          type="button"
          className="lb-close"
          aria-label={t('lightbox.close')}
          onClick={onClose}
        >
          ✕
        </button>
        {images.length > 1 && (
          <>
            <button
              type="button"
              className="lb-nav prev"
              aria-label={t('lightbox.prev')}
              onClick={() => go(-1)}
            >
              ‹
            </button>
            <button
              type="button"
              className="lb-nav next"
              aria-label={t('lightbox.next')}
              onClick={() => go(1)}
            >
              ›
            </button>
          </>
        )}
        <div className="lb-img">
          <img src={img.url} alt={img.label ?? t('lightbox.title')} />
        </div>
        <div className="lb-foot">
          <span>{img.label}</span>
          <span className="count">
            {cur + 1}/{images.length}
          </span>
        </div>
      </div>
    </div>
  );
}
