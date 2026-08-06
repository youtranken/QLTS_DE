import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/ui/data-table';
import { LoadError, Loading } from '@/ui/load-state';
import { STATUS_BADGE } from '@/lib/asset-types';
import type { Me } from '@/lib/me';

interface Device {
  id: string;
  code: string | null;
  type: string;
  configuration: string | null;
  brand: string | null;
  model: string | null;
  status: string;
  start_date: string | null;
}
interface Software {
  id: string;
  name: string | null;
  license_type: string | null;
  end_date: string | null;
  status: string;
  host_code: string | null;
}
interface HistoryRow {
  id: string;
  from_user_sub: string | null;
  to_user_sub: string | null;
  from_name: string | null;
  to_name: string | null;
  actor_name: string | null;
  note: string | null;
  asset_code: string | null;
  asset_type: string;
  created_at: string;
}
interface MyAssets {
  devices: Device[];
  software: Software[];
  history: HistoryRow[];
}

type Tab = 'assets' | 'software' | 'history' | 'info';

/** UP-5.2: hồ sơ "của tôi" — route /ho-so. Không avatar (theo yêu cầu). */
export function ProfilePage({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<MyAssets | null>(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>('assets');

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch('/api/me/assets');
      if (res.status === 401) {
        window.location.href = '/';
        return;
      }
      if (!res.ok) {
        setError(true);
        return;
      }
      setData((await res.json()) as MyAssets);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fmtDate = useCallback(
    (iso: string | null) =>
      iso ? new Date(iso).toLocaleDateString(i18n.language) : '—',
    [i18n.language],
  );

  const statusBadge = useCallback(
    (status: string) => (
      <span className={`badge ${STATUS_BADGE[status] ?? 'muted'}`}>
        {t(`assets.status.${status}`, status)}
      </span>
    ),
    [t],
  );

  const deviceCols = useMemo<ColumnDef<Device, unknown>[]>(
    () => [
      {
        id: 'code',
        accessorKey: 'code',
        header: t('profile.colCode'),
        cell: ({ row }) => <span className="mono">{row.original.code ?? '—'}</span>,
      },
      { id: 'type', accessorKey: 'type', header: t('profile.colType') },
      {
        id: 'configuration',
        header: t('profile.colConfig'),
        cell: ({ row }) =>
          row.original.configuration ??
          [row.original.brand, row.original.model].filter(Boolean).join(' ') ??
          '—',
      },
      {
        id: 'received',
        header: t('profile.colReceived'),
        cell: ({ row }) => fmtDate(row.original.start_date),
      },
      {
        id: 'status',
        accessorKey: 'status',
        header: t('profile.colStatus'),
        cell: ({ row }) => statusBadge(row.original.status),
      },
    ],
    [t, fmtDate, statusBadge],
  );

  const roleLabel =
    me.role === 'admin'
      ? t('profile.roleAdmin')
      : me.role === 'sa'
        ? t('profile.roleSa')
        : t('profile.roleMember');

  if (error) return <LoadError onRetry={load} />;
  if (!data) return <Loading />;

  const lastActivity = data.history[0]?.created_at ?? null;

  return (
    <div className="profile-page">
      <header className="profile-head">
        <div className="ph-main">
          <div className="ph-name-row">
            <h1>{me.fullName ?? me.sub}</h1>
            <span className="chip">{roleLabel}</span>
          </div>
          {me.email && <div className="ph-email">{me.email}</div>}
        </div>
      </header>

      <div className="profile-stat-grid">
        <div className="profile-stat-card">
          <div className="sc-label">{t('profile.statDevices')}</div>
          <div className="sc-num">{data.devices.length}</div>
        </div>
        <div className="profile-stat-card">
          <div className="sc-label">{t('profile.statSoftware')}</div>
          <div className="sc-num">{data.software.length}</div>
        </div>
        <div className="profile-stat-card">
          <div className="sc-label">{t('profile.statLastActivity')}</div>
          <div className="sc-num sc-date">{fmtDate(lastActivity)}</div>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {(['assets', 'software', 'history', 'info'] as Tab[]).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? 'tab active' : 'tab'}
            onClick={() => setTab(k)}
          >
            {t(
              `profile.tab${k.charAt(0).toUpperCase()}${k.slice(1)}` as
                | 'profile.tabAssets'
                | 'profile.tabSoftware'
                | 'profile.tabHistory'
                | 'profile.tabInfo',
            )}
          </button>
        ))}
      </div>

      {tab === 'assets' && (
        <div className="section-gap">
          <DataTable
            data={data.devices}
            columns={deviceCols}
            emptyText={t('profile.emptyDevices')}
            stackOnMobile
          />
        </div>
      )}

      {tab === 'software' && (
        <div className="section-gap sw-list">
          {data.software.length === 0 ? (
            <p className="muted">{t('profile.emptySoftware')}</p>
          ) : (
            data.software.map((s) => (
              <div className="sw-row" key={s.id}>
                <div className="sw-main">
                  <div className="sw-nm">{s.name ?? '—'}</div>
                  <div className="sw-meta">
                    {s.host_code && (
                      <>
                        {t('profile.swHost')} <b>{s.host_code}</b>
                        {' · '}
                      </>
                    )}
                    {s.license_type === 'perpetual'
                      ? t('profile.swPerpetual')
                      : fmtDate(s.end_date)}
                  </div>
                </div>
                {statusBadge(s.status)}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="section-gap">
          {data.history.length === 0 ? (
            <p className="muted">{t('profile.emptyHistory')}</p>
          ) : (
            <div className="timeline">
              {data.history.map((h) => {
                const incoming = h.to_user_sub === me.sub;
                return (
                  <div className="tl-item" key={h.id}>
                    <span
                      className={`tl-dot ${incoming ? 'in' : 'out'}`}
                      aria-hidden="true"
                    />
                    <div className="tl-time">{fmtDate(h.created_at)}</div>
                    <div className="tl-title">
                      {incoming ? t('profile.received') : t('profile.handedOver')}{' '}
                      <span className="mono">{h.asset_code ?? '—'}</span>
                    </div>
                    {h.note && <div className="tl-desc">{h.note}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'info' && (
        <div className="section-gap info-grid">
          <div className="info-item">
            <div className="ii-k">{t('profile.fInfoName')}</div>
            <div className="ii-v">{me.fullName ?? t('profile.none')}</div>
          </div>
          <div className="info-item">
            <div className="ii-k">{t('profile.fInfoEmail')}</div>
            <div className="ii-v">{me.email ?? t('profile.none')}</div>
          </div>
          <div className="info-item">
            <div className="ii-k">{t('profile.fInfoRole')}</div>
            <div className="ii-v">{roleLabel}</div>
          </div>
          <div className="info-item">
            <div className="ii-k">{t('profile.fInfoSub')}</div>
            <div className="ii-v mono">{me.sub}</div>
          </div>
        </div>
      )}
    </div>
  );
}
