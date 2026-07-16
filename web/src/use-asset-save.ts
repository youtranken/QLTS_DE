import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { AssetDetail, AssetRow, FormState } from './asset-types';
import type { Seat } from './software-seats-fields';

/**
 * Cụm LƯU form tài sản (tạo/sửa): tạo phần mềm theo từng bản (seat), tạo/sửa máy, và gắn
 * phần mềm chọn sẵn sau khi tạo máy. Tách khỏi hub (§6) vì đây là một luồng riêng, không
 * đụng vòng đời/transfer. Hành vi giữ nguyên — logic bê nguyên từ asset-form.
 */
export function useAssetSave(ctx: {
  form: FormState;
  seats: Seat[];
  pendingSw: AssetRow[];
  csrfToken: string | null | undefined;
  onDone: (saved: boolean) => void;
  setError: (v: string | null) => void;
  setBusy: (v: boolean) => void;
  setStale: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const { form, seats, pendingSw, csrfToken, onDone, setError, setBusy, setStale } =
    ctx;

  // #2: gắn 1 phần mềm vào máy MỚI tạo (dùng lại endpoint transfer, không cần form.id).
  const attachSoftwareToMachine = useCallback(
    async (softwareId: string, machineId: string) => {
      const detailRes = await fetch(
        `/api/admin/assets/${encodeURIComponent(softwareId)}`,
      );
      if (!detailRes.ok) return;
      const sw = (await detailRes.json()) as AssetDetail;
      await fetch(`/api/admin/assets/${encodeURIComponent(softwareId)}/transfer`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        body: JSON.stringify({ targetAssetId: machineId, version: sw.version }),
      });
    },
    [csrfToken],
  );

  const submit = useCallback(async () => {
    setError(null);
    // Ngày hết hạn phải SAU ngày đưa vào dùng (đại tu UAT) — chặn trước khi gọi API.
    if (form.startDate && form.endDate && form.endDate <= form.startDate) {
      setError(t('assets.endBeforeStart'));
      return;
    }
    setBusy(true);
    const payload: Record<string, unknown> = {
      // Phần mềm: KHÔNG có mã/cấu hình/người đứng tên (BE cũng normalize) — gửi null để
      // qua DTO @IsOptional (chuỗi rỗng '' sẽ trượt @Length(1,100) → 400).
      code: form.isSoftware ? null : form.code,
      type: form.isSoftware ? 'software' : form.type,
      configuration: form.isSoftware ? null : form.configuration || null,
      cost: form.cost === '' ? null : Number(form.cost),
      startDate: form.startDate || null,
      // perpetual không có hạn — không gửi endDate còn sót lại trong state
      endDate:
        form.isSoftware && form.licenseType === 'perpetual'
          ? null
          : form.endDate || null,
      note: form.note || null,
      serial: form.serial || null,
      // Place (vị trí) — chỉ máy; phần mềm không gửi.
      floor: form.isSoftware ? null : form.floor || null,
      brand: form.brand || null,
      assignedUserSub: form.isSoftware ? null : form.assignedUserSub || null,
      licenseType: form.isSoftware ? form.licenseType || null : null,
      // term cũng được có tên license — không xóa ngầm khi sửa (review 2.4)
      licenseName: form.isSoftware ? form.licenseName || null : null,
    };
    if (form.id) {
      // Người đứng tên sửa NGAY trong Thông tin chung → assignedUserSub trong payload là giá
      // trị MỚI; BE PUT máy tự đổi assigned_user_sub + ghi allocation_history (assets.service §297).
      payload.version = form.version;
    }
    // TẠO phần mềm: mỗi "bản" (seat) = 1 bản ghi riêng, kỳ hạn + ghi chú RIÊNG, chưa gắn máy
    // (gán từng bản vào máy sau ở trang chi tiết license).
    if (!form.id && form.isSoftware) {
      for (let i = 0; i < seats.length; i++) {
        const s = seats[i];
        if (form.licenseType === 'term' && !s.endDate) {
          setError(t('software.seatEndRequired', { i: i + 1 }));
          setBusy(false);
          return;
        }
        if (s.startDate && s.endDate && s.endDate <= s.startDate) {
          setError(t('software.seatEndBeforeStart', { i: i + 1 }));
          setBusy(false);
          return;
        }
      }
      let failed = 0;
      for (const s of seats) {
        const seatPayload = {
          ...payload,
          startDate: s.startDate || null,
          endDate: form.licenseType === 'perpetual' ? null : s.endDate || null,
          cost: s.cost === '' ? null : Number(s.cost),
          note: s.note || null,
        };
        const ok = await fetch('/api/admin/assets', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
          body: JSON.stringify(seatPayload),
        })
          .then((r) => r.ok)
          .catch(() => false);
        if (!ok) failed++;
      }
      setBusy(false);
      if (failed > 0) {
        setError(t('software.bulkPartial', { n: failed, total: seats.length }));
        return;
      }
      onDone(true);
      return;
    }
    try {
      const res = await fetch(
        form.id
          ? `/api/admin/assets/${encodeURIComponent(form.id)}`
          : '/api/admin/assets',
        {
          method: form.id ? 'PUT' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
          body: JSON.stringify(payload),
        },
      );
      if (res.ok) {
        // #2: tạo máy xong + có phần mềm chọn sẵn → gắn từng cái vào máy vừa tạo.
        if (!form.id && !form.isSoftware && pendingSw.length > 0) {
          const created = (await res
            .json()
            .catch(() => null)) as { id?: string } | null;
          let failed = 0;
          if (created?.id) {
            for (const sw of pendingSw) {
              const ok = await attachSoftwareToMachine(sw.id, created.id)
                .then(() => true)
                .catch(() => false);
              if (!ok) failed++;
            }
          } else {
            failed = pendingSw.length; // thiếu id máy trong response → không gắn được cái nào
          }
          if (failed > 0) {
            // Máy ĐÃ tạo nhưng gắn phần mềm lỗi — báo rõ (giữ modal) thay vì im lặng
            // báo thành công. Người dùng gắn lại qua "Sửa máy" khi thấy máy trong danh sách.
            setError(t('assets.attachAfterCreate', { n: failed }));
            setBusy(false);
            return;
          }
        }
        onDone(true);
        return;
      }
      const body = (await res.json()) as { code?: string; message?: string };
      if (body.code === 'STALE_VERSION') {
        setError(t('assets.staleVersion'));
        setStale(true);
      } else if (body.code === 'CODE_TAKEN') {
        setError(t('assets.codeTaken'));
      } else {
        setError(body.message ?? t('assets.saveFailed'));
      }
    } catch {
      setError(t('app.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }, [form, pendingSw, seats, csrfToken, onDone, setError, setBusy, setStale, t, attachSoftwareToMachine]);

  return submit;
}
