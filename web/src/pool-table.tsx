import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AssetTypeIcon } from './asset-type-icon';
import type { PoolItem } from './pool-types';

/**
 * Bảng pool (theo pool.html): No / Code / User(người đang mượn) / Asset Type / Software / Gỡ.
 * Cột Software: 0 → "—"; 1 → tên trực tiếp; ≥2 → chip "N phần mềm ›" bung hàng liệt kê.
 * Tách khỏi pool-page (§6) — chỉ trình bày, state expand cục bộ.
 */
export function PoolTable({
  items,
  busy,
  onRemove,
}: {
  items: PoolItem[];
  busy: boolean;
  onRemove: (it: PoolItem) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="table-wrap">
      <table className="table pool-table">
        <thead>
          <tr>
            <th style={{ width: '3rem' }}>{t('pool.colNo', 'No')}</th>
            <th>{t('pool.colCode2', 'Code')}</th>
            <th>{t('pool.colUser', 'User')}</th>
            <th>{t('pool.colAssetType', 'Asset Type')}</th>
            <th>{t('pool.colSw', 'Software')}</th>
            <th className="right" aria-label={t('pool.remove')} />
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => {
            const sw = it.installedSoftware
              ? it.installedSoftware.split(', ').filter(Boolean)
              : [];
            const open = expanded.has(it.id);
            return [
              <tr key={it.id}>
                <td className="muted">{i + 1}</td>
                <td>
                  <span className="mono">{it.code}</span>
                  {it.brand && <span className="cell-sub"> · {it.brand}</span>}
                </td>
                <td>
                  {it.currentBorrowerName ? (
                    it.currentBorrowerName
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <span className="pool-type">
                    <AssetTypeIcon type={it.type} />
                    <span>{it.type}</span>
                  </span>
                </td>
                <td>
                  {sw.length === 0 ? (
                    <span className="muted">—</span>
                  ) : sw.length === 1 ? (
                    <span className="pool-sw-one">{sw[0]}</span>
                  ) : (
                    <button
                      type="button"
                      className={`sw-chip${open ? ' open' : ''}`}
                      aria-expanded={open}
                      onClick={() => toggle(it.id)}
                    >
                      {t('pool.swCount', '{{n}} phần mềm', { n: sw.length })}
                      <span className="sw-chip-caret" aria-hidden="true">
                        ›
                      </span>
                    </button>
                  )}
                </td>
                <td className="right">
                  <button
                    type="button"
                    className="sm danger"
                    disabled={busy}
                    onClick={() => onRemove(it)}
                  >
                    {t('pool.remove')}
                  </button>
                </td>
              </tr>,
              open && sw.length > 1 ? (
                <tr key={`${it.id}-sw`} className="pool-sw-row">
                  <td colSpan={6}>
                    <div className="pool-sw-list">
                      {sw.map((s, si) => (
                        <span className="pool-sw-item" key={`${s}-${si}`}>
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
