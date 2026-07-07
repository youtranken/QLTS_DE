import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface AvailableSoftware {
  id: string;
  code: string;
  licenseName: string | null;
  licenseType: string | null;
}
interface AvailableMachine {
  id: string;
  code: string;
  type: string;
  configuration: string | null;
  brand: string | null;
  model: string | null;
  floor: string | null;
  software: AvailableSoftware[];
}

/**
 * Landing đặt máy (3.1b): chọn khung giờ → xem máy pool rảnh kèm cấu hình + software.
 * datetime-local trả giờ LOCAL không offset; new Date(...).toISOString() quy về UTC 'Z'
 * — giữ đúng INSTANT, server nhận offset hợp lệ (party phiên 7 chống lệch giờ).
 * Nút "Chọn" (submit đặt) là story 3.1c.
 */
export function BookingPage() {
  const { t } = useTranslation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [machines, setMachines] = useState<AvailableMachine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async () => {
    setError(null);
    if (!from || !to) return;
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();
    setLoading(true);
    try {
      const res = await fetch(
        `/api/booking/availability?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
      );
      if (res.ok) {
        setMachines((await res.json()) as AvailableMachine[]);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      const map: Record<string, string> = {
        INVALID_RANGE: t('booking.errInvalidRange'),
        PAST_PICKUP: t('booking.errPast'),
        BOOKING_WINDOW: t('booking.errWindow'),
      };
      setError((body.code && map[body.code]) || t('booking.errGeneric'));
      setMachines(null);
    } catch {
      setError(t('booking.errGeneric'));
      setMachines(null);
    } finally {
      setLoading(false);
    }
  }, [from, to, t]);

  return (
    <section style={{ maxWidth: 900 }}>
      <h1 style={{ fontSize: '1.3rem', marginBottom: '1rem' }}>
        {t('booking.title')}
      </h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
        style={{
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          marginBottom: '1rem',
        }}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {t('booking.from')}
          <input
            type="datetime-local"
            value={from}
            required
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {t('booking.to')}
          <input
            type="datetime-local"
            value={to}
            required
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button type="submit" disabled={loading || !from || !to}>
          {loading ? t('booking.searching') : t('booking.search')}
        </button>
      </form>

      {error && <p style={{ color: '#c0392b' }}>{error}</p>}

      {machines === null && !error && <p>{t('booking.prompt')}</p>}
      {machines !== null && machines.length === 0 && (
        <p>{t('booking.empty')}</p>
      )}
      {machines !== null && machines.length > 0 && (
        <>
          <p>{t('booking.resultCount', { n: machines.length })}</p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  {[
                    'colCode',
                    'colType',
                    'colConfig',
                    'colFloor',
                    'colSoftware',
                  ].map((k) => (
                    <th
                      key={k}
                      style={{
                        textAlign: 'left',
                        borderBottom: '1px solid #ccc',
                        padding: '0.4rem',
                      }}
                    >
                      {t(`booking.${k}`)}
                    </th>
                  ))}
                  <th style={{ borderBottom: '1px solid #ccc' }} />
                </tr>
              </thead>
              <tbody>
                {machines.map((m) => (
                  <tr key={m.id}>
                    <td style={{ padding: '0.4rem' }}>{m.code}</td>
                    <td style={{ padding: '0.4rem' }}>{m.type}</td>
                    <td style={{ padding: '0.4rem' }}>
                      {m.configuration ?? '—'}
                    </td>
                    <td style={{ padding: '0.4rem' }}>{m.floor ?? '—'}</td>
                    <td style={{ padding: '0.4rem' }}>
                      {m.software.length === 0
                        ? t('booking.noSoftware')
                        : m.software
                            .map((s) => s.licenseName || s.code)
                            .join(', ')}
                    </td>
                    <td style={{ padding: '0.4rem' }}>
                      <button type="button" disabled title="3.1c">
                        {t('booking.pick')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
