import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Combobox } from './combobox';
import type { Me } from './panels';
import type { AllocationRow, UserOption } from './asset-types';

/**
 * Story 11.2 (B3): đổi Người đứng tên MÁY là thao tác RIÊNG — KHÔNG qua "Lưu thông tin máy".
 * Gọi PUT :id/assignee (chỉ đụng assigned_user_sub + allocation_history). Tự nạp users + lịch sử.
 * Chỉ dùng khi SỬA một thiết bị (máy đã tồn tại). Phần mềm không có người đứng tên.
 */
export function AssetOwnerPanel({
  me,
  assetId,
  version,
  ownerSub,
  ownerName,
  onSaved,
}: {
  me: Me;
  assetId: string;
  version: number;
  ownerSub: string | null;
  ownerName: string | null;
  onSaved: (
    nextVersion: number,
    sub: string | null,
    name: string | null,
  ) => void;
}) {
  const { t, i18n } = useTranslation();
  // '' (form dùng chuỗi rỗng cho "kho") ≡ null — chuẩn hóa để dirty không báo giả.
  const [draftSub, setDraftSub] = useState<string | null>(ownerSub || null);
  const [draftName, setDraftName] = useState<string | null>(ownerName || null);
  const [note, setNote] = useState('');
  const [userQuery, setUserQuery] = useState('');
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  const [allocations, setAllocations] = useState<AllocationRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // owner ngoài đổi (sau khi lưu, parent cập nhật) → đồng bộ draft.
  useEffect(() => {
    setDraftSub(ownerSub || null);
    setDraftName(ownerName || null);
  }, [ownerSub, ownerName]);

  const loadAllocations = useCallback(() => {
    fetch(`/api/admin/assets/${encodeURIComponent(assetId)}/allocations`)
      .then(async (r) => {
        if (r.ok) setAllocations((await r.json()) as AllocationRow[]);
      })
      .catch(() => undefined);
  }, [assetId]);
  useEffect(() => loadAllocations(), [loadAllocations]);

  useEffect(() => {
    if (!userQuery) {
      setUserOptions([]);
      return;
    }
    const c = new AbortController();
    const timer = setTimeout(() => {
      fetch(
        `/api/admin/users?search=${encodeURIComponent(userQuery)}&page=1&pageSize=20`,
        { signal: c.signal },
      )
        .then(async (r) => {
          if (r.ok) {
            const b = (await r.json()) as { items?: UserOption[] };
            setUserOptions(b.items ?? []);
          }
        })
        .catch(() => undefined);
    }, 300);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [userQuery]);

  const dirty = (draftSub || null) !== (ownerSub || null);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(
        `/api/admin/assets/${encodeURIComponent(assetId)}/assignee`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(me.csrfToken ? { 'X-CSRF-Token': me.csrfToken } : {}),
          },
          body: JSON.stringify({
            assignedUserSub: draftSub || null,
            allocationNote: note.trim() || null,
            version,
          }),
        },
      );
      if (res.ok) {
        const body = (await res.json()) as { version: number };
        onSaved(body.version, draftSub || null, draftName || null);
        setNote('');
        setSaved(true);
        loadAllocations();
        return;
      }
      const body = (await res.json()) as { code?: string; message?: string };
      setError(
        body.code === 'STALE_VERSION'
          ? t('assets.staleVersion')
          : (body.message ?? t('assets.saveFailed')),
      );
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }, [assetId, draftSub, draftName, note, version, me.csrfToken, onSaved, loadAllocations, t]);

  return (
    <div className="form-section">
      <div className="form-section-title">{t('assets.assignee')}</div>
      {error && <p className="alert error">{error}</p>}
      {saved && <p className="muted">{t('assets.ownerSaved')}</p>}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.6rem',
          marginBottom: '0.6rem',
          flexWrap: 'wrap',
        }}
      >
        {draftSub ? (
          <span className="chip">
            {draftName || draftSub}
            <button
              type="button"
              aria-label={t('assets.cancel')}
              onClick={() => {
                setDraftSub(null);
                setDraftName(null);
              }}
            >
              ✕
            </button>
          </span>
        ) : (
          <span className="muted">{t('assets.assigneeEmpty')}</span>
        )}
      </div>
      <Combobox
        placeholder={t('assets.assigneeSearch')}
        query={userQuery}
        onQuery={setUserQuery}
        options={userOptions}
        getKey={(u) => u.sub}
        renderOption={(u) => (
          <>
            <span>{u.fullName ?? u.sub}</span>
            {u.email && <small>{u.email}</small>}
          </>
        )}
        onSelect={(u) => {
          setDraftSub(u.sub);
          setDraftName(u.fullName ?? u.sub);
          setUserQuery('');
          setUserOptions([]);
        }}
      />
      <label className="field" style={{ marginTop: '0.75rem' }}>
        <span>{t('assets.allocationNote')}</span>
        <input
          maxLength={500}
          placeholder={t('assets.allocationNotePlaceholder')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <div style={{ marginTop: '0.6rem' }}>
        <button
          type="button"
          className="primary"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          {busy && <span className="spinner" style={{ marginRight: 6 }} />}
          {t('assets.saveOwner')}
        </button>
      </div>
      {allocations.length > 0 && (
        <div className="table-wrap" style={{ marginTop: '0.8rem' }}>
          <div className="form-section-title">
            {t('assets.allocationHistory')}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t('assets.allocDate')}</th>
                <th>{t('assets.allocFrom')}</th>
                <th>{t('assets.allocTo')}</th>
                <th>{t('assets.allocActor')}</th>
                <th>{t('assets.note')}</th>
              </tr>
            </thead>
            <tbody>
              {allocations.map((h) => (
                <tr key={h.id}>
                  <td>
                    {new Date(h.createdAt).toLocaleString(
                      i18n.language === 'en' ? 'en-GB' : 'vi-VN',
                    )}
                  </td>
                  <td>
                    {h.fromUserSub
                      ? (h.fromUserName ?? h.fromUserSub)
                      : t('assets.stock')}
                  </td>
                  <td>
                    {h.toUserSub
                      ? (h.toUserName ?? h.toUserSub)
                      : t('assets.stock')}
                  </td>
                  <td>{h.actorName ?? h.actor}</td>
                  <td>{h.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
