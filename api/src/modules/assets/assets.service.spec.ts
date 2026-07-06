import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import {
  AssetsService,
  diffChanged,
  validateSoftwareInput,
} from './assets.service';
import type { AssetInput } from './assets.service';
import type { Database } from '../../database/database.module';
import type { AuditWriterService } from '../audit/audit-writer.service';
import type { SystemConfigService } from '../config/system-config.service';

const baseInput: AssetInput = {
  code: '3-AA-CT-0042',
  type: 'laptop',
  configuration: null,
  cost: 15000000,
  startDate: '2026-01-15',
  endDate: null,
  floor: '3',
  note: null,
  serial: null,
  brand: null,
  model: null,
  assignedUserSub: null,
  licenseType: null,
  licenseName: null,
};

function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('pg error'), { code, constraint });
}

/** Mock db mà create/update chạy trong transaction: db.transaction(cb) → cb(tx). */
function makeService(tx: Partial<Record<string, unknown>>) {
  const audit = {
    append: jest.fn().mockResolvedValue(undefined),
    appendWithin: jest.fn().mockResolvedValue(undefined),
  };
  const db = {
    ...tx,
    transaction: (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };
  const config = { getLicenseWarningDays: jest.fn().mockResolvedValue(30) };
  const svc = new AssetsService(
    db as unknown as Database,
    audit as unknown as AuditWriterService,
    config as unknown as SystemConfigService,
  );
  return { svc, audit };
}

async function catchHttp(promise: Promise<unknown>): Promise<HttpException> {
  const err = await promise.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpException);
  return err as HttpException;
}

describe('AssetsService (story 2.1)', () => {
  it('create: mã trùng (23505 assets_code_key) → 409 CODE_TAKEN, KHÔNG ghi audit', async () => {
    const db = {
      insert: () => ({
        values: () => ({
          returning: () => Promise.reject(pgError('23505', 'assets_code_key')),
        }),
      }),
    };
    const { svc, audit } = makeService(db);
    const err = await catchHttp(svc.create(baseInput, 'admin-1'));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'CODE_TAKEN' });
    expect(audit.appendWithin).not.toHaveBeenCalled();
  });

  it('create: người đứng tên không tồn tại (23503) → 400 ASSIGNEE_NOT_FOUND', async () => {
    const db = {
      insert: () => ({
        values: () => ({
          returning: () => Promise.reject(pgError('23503')),
        }),
      }),
    };
    const { svc } = makeService(db);
    const err = await catchHttp(
      svc.create({ ...baseInput, assignedUserSub: 'ma' }, 'admin-1'),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'ASSIGNEE_NOT_FOUND' });
  });

  it('create: ngày không hợp lệ lọt tới DB (22007) → 400 BAD_DATE', async () => {
    const db = {
      insert: () => ({
        values: () => ({
          returning: () => Promise.reject(pgError('22007')),
        }),
      }),
    };
    const { svc } = makeService(db);
    const err = await catchHttp(svc.create(baseInput, 'admin-1'));
    expect(err.getResponse()).toMatchObject({ code: 'BAD_DATE' });
  });

  it('create: thành công → audit assets.create với actor/objectId', async () => {
    const created = { id: 'uuid-1', code: baseInput.code, type: 'laptop' };
    const db = {
      insert: () => ({
        values: () => ({ returning: () => Promise.resolve([created]) }),
      }),
    };
    const { svc, audit } = makeService(db);
    await svc.create(baseInput, 'admin-1');
    expect(audit.appendWithin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: 'admin-1',
        action: 'assets.create',
        objectId: 'uuid-1',
      }),
    );
  });

  it('update: version lệch nhưng asset tồn tại → 409 STALE_VERSION (AC 3)', async () => {
    const db = {
      execute: () => Promise.resolve({ rows: [] }),
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ id: 'uuid-1' }]) }),
      }),
    };
    const { svc, audit } = makeService(db);
    const err = await catchHttp(svc.update('uuid-1', baseInput, 1, 'admin-1'));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'STALE_VERSION' });
    expect(audit.appendWithin).not.toHaveBeenCalled();
  });

  it('update: asset không tồn tại → 404 ASSET_NOT_FOUND', async () => {
    const db = {
      execute: () => Promise.resolve({ rows: [] }),
      select: () => ({
        from: () => ({ where: () => Promise.resolve([]) }),
      }),
    };
    const { svc } = makeService(db);
    const err = await catchHttp(svc.update('uuid-x', baseInput, 1, 'admin-1'));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.getResponse()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
  });

  it('update: thành công → audit assets.update chỉ chứa trường ĐỔI (from→to)', async () => {
    const oldRow = {
      new_version: 2,
      old_code: baseInput.code,
      old_type: 'laptop',
      old_configuration: null,
      old_cost: '15000000', // pg trả bigint dạng string
      old_start_date: '2026-01-15',
      old_end_date: null,
      old_floor: '3',
      old_note: null,
      old_serial: null,
      old_brand: null,
      old_model: null,
      old_assigned_user_sub: null,
    };
    const historyValues = jest.fn().mockResolvedValue(undefined);
    const db = {
      execute: () => Promise.resolve({ rows: [oldRow] }),
      insert: () => ({ values: historyValues }),
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ type: 'laptop' }]) }),
      }),
    };
    const { svc, audit } = makeService(db);
    const res = await svc.update(
      'uuid-1',
      { ...baseInput, cost: 20000000, assignedUserSub: 'sub-m1' },
      1,
      'admin-1',
      'bàn giao kèm sạc',
    );
    expect(res).toEqual({ ok: true, version: 2 });
    const call = audit.appendWithin.mock.calls[0][1] as {
      detail: { changed: Record<string, unknown> };
    };
    expect(call.detail.changed).toEqual({
      cost: { from: '15000000', to: '20000000' },
      assigned_user_sub: { from: null, to: 'sub-m1' },
    });
    // 2.3: đổi người → allocation_history from→to + note
    expect(historyValues).toHaveBeenCalledWith({
      assetId: 'uuid-1',
      fromUserSub: null,
      toUserSub: 'sub-m1',
      note: 'bàn giao kèm sạc',
      actor: 'admin-1',
    });
  });

  it('update: KHÔNG đổi người đứng tên → KHÔNG ghi allocation_history (2.3)', async () => {
    const oldRow = {
      new_version: 2,
      old_code: baseInput.code,
      old_type: 'laptop',
      old_configuration: null,
      old_cost: '15000000',
      old_start_date: '2026-01-15',
      old_end_date: null,
      old_floor: '3',
      old_note: null,
      old_serial: null,
      old_brand: null,
      old_model: null,
      old_assigned_user_sub: 'sub-m1',
    };
    const historyValues = jest.fn().mockResolvedValue(undefined);
    const db = {
      execute: () => Promise.resolve({ rows: [oldRow] }),
      insert: () => ({ values: historyValues }),
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ type: 'laptop' }]) }),
      }),
    };
    const { svc } = makeService(db);
    await svc.update(
      'uuid-1',
      { ...baseInput, note: 'chỉ sửa ghi chú', assignedUserSub: 'sub-m1' },
      1,
      'admin-1',
      'note này phải bị bỏ qua',
    );
    expect(historyValues).not.toHaveBeenCalled();
  });

  it('update: đổi type qua/lại software → 400 TYPE_SOFTWARE_IMMUTABLE (2.4)', async () => {
    const db = {
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ type: 'software' }]) }),
      }),
    };
    const { svc } = makeService(db);
    const err = await catchHttp(
      svc.update('uuid-1', { ...baseInput, type: 'laptop' }, 1, 'admin-1'),
    );
    expect(err.getResponse()).toMatchObject({
      code: 'TYPE_SOFTWARE_IMMUTABLE',
    });
  });

  it('create: có người đứng tên → seed allocation_history from NULL (2.3)', async () => {
    const created = {
      id: 'uuid-1',
      code: baseInput.code,
      type: 'laptop',
      assignedUserSub: 'sub-m1',
    };
    const historyValues = jest.fn().mockResolvedValue(undefined);
    const db = {
      insert: jest
        .fn()
        // lần 1: insert assets; lần 2: insert allocation_history
        .mockReturnValueOnce({
          values: () => ({ returning: () => Promise.resolve([created]) }),
        })
        .mockReturnValueOnce({ values: historyValues }),
    };
    const { svc } = makeService(db);
    await svc.create({ ...baseInput, assignedUserSub: 'sub-m1' }, 'admin-1');
    expect(historyValues).toHaveBeenCalledWith({
      assetId: 'uuid-1',
      fromUserSub: null,
      toUserSub: 'sub-m1',
      note: null,
      actor: 'admin-1',
    });
  });
});

describe('transferLicense (2.5, FR-50)', () => {
  it('nguồn không phải software → 400 NOT_SOFTWARE, không audit', async () => {
    const db = {
      execute: () => Promise.resolve({ rows: [] }),
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ type: 'laptop' }]) }),
      }),
    };
    const { svc, audit } = makeService(db);
    const err = await catchHttp(svc.transferLicense('uuid-1', null, 1, 'adm'));
    expect(err.getResponse()).toMatchObject({ code: 'NOT_SOFTWARE' });
    expect(audit.appendWithin).not.toHaveBeenCalled();
  });

  it('version lệch → 409 STALE_VERSION', async () => {
    const db = {
      execute: () => Promise.resolve({ rows: [] }),
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ type: 'software' }]) }),
      }),
    };
    const { svc } = makeService(db);
    const err = await catchHttp(svc.transferLicense('uuid-1', null, 1, 'adm'));
    expect(err.getResponse()).toMatchObject({ code: 'STALE_VERSION' });
  });

  it('gỡ về "chưa gắn máy" → audit from→to null', async () => {
    const db = {
      execute: () =>
        Promise.resolve({ rows: [{ new_version: 2, old_target: 'may-a' }] }),
    };
    const { svc, audit } = makeService(db);
    const res = await svc.transferLicense('uuid-1', null, 1, 'adm');
    expect(res).toEqual({ ok: true, version: 2 });
    expect(audit.appendWithin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'assets.license_transfer',
        detail: { from: 'may-a', to: null },
      }),
    );
  });
});

describe('lifecycle (2.6, FR-33/32)', () => {
  const lockRow = (row: Record<string, unknown> | null) => ({
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => Promise.resolve(row ? [row] : []),
        }),
      }),
    }),
  });

  it('lock software → 400 NOT_MACHINE', async () => {
    const { svc } = makeService(
      lockRow({
        type: 'software',
        status: 'in_use',
        isPool: false,
        version: 1,
      }),
    );
    const err = await catchHttp(svc.lock('u1', 'hỏng', null, 1, 'adm'));
    expect(err.getResponse()).toMatchObject({ code: 'NOT_MACHINE' });
  });

  it('lock máy đang khóa → 409 INVALID_STATE', async () => {
    const { svc } = makeService(
      lockRow({
        type: 'laptop',
        status: 'locked_repair',
        isPool: true,
        version: 1,
      }),
    );
    const err = await catchHttp(svc.lock('u1', 'hỏng', null, 1, 'adm'));
    expect(err.getResponse()).toMatchObject({ code: 'INVALID_STATE' });
  });

  it('version lệch → 409 STALE_VERSION (trước cả guard state)', async () => {
    const { svc } = makeService(
      lockRow({ type: 'laptop', status: 'in_use', isPool: false, version: 5 }),
    );
    const err = await catchHttp(svc.unlock('u1', 1, 'adm'));
    expect(err.getResponse()).toMatchObject({ code: 'STALE_VERSION' });
  });

  it('unlock software → 400 NOT_MACHINE (đóng ma trận guard)', async () => {
    const { svc } = makeService(
      lockRow({
        type: 'software',
        status: 'locked_repair',
        isPool: false,
        version: 1,
      }),
    );
    const err = await catchHttp(svc.unlock('u1', 1, 'adm'));
    expect(err.getResponse()).toMatchObject({ code: 'NOT_MACHINE' });
  });

  it('setPool cùng giá trị → no-op: không audit, version giữ nguyên', async () => {
    const { svc, audit } = makeService(
      lockRow({ type: 'laptop', status: 'in_use', isPool: true, version: 3 }),
    );
    const res = await svc.setPool('u1', true, 3, 'adm');
    expect(res).toEqual({ ok: true, version: 3 });
    expect(audit.appendWithin).not.toHaveBeenCalled();
  });

  it('dispose máy → detach license + audit dispose kèm danh sách mã', async () => {
    const tx = {
      ...lockRow({
        type: 'laptop',
        status: 'in_use',
        isPool: false,
        version: 2,
      }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
      insert: () => ({ values: () => Promise.resolve() }),
      execute: () => Promise.resolve({ rows: [{ code: 'SW-01' }] }),
    };
    const { svc, audit } = makeService(tx);
    const res = await svc.dispose('u1', 2, 'adm');
    expect(res).toEqual({ ok: true, version: 3 });
    const actions = audit.appendWithin.mock.calls.map(
      (c: unknown[]) => (c[1] as { action: string }).action,
    );
    expect(actions).toEqual(['assets.license_detach_all', 'assets.dispose']);
    const disposeDetail = audit.appendWithin.mock.calls[1][1] as {
      detail: { detached: string[] };
    };
    expect(disposeDetail.detail.detached).toEqual(['SW-01']);
  });
});

describe('validateSoftwareInput (2.4, FR-38)', () => {
  const sw = { ...baseInput, type: 'software' };

  it('software thiếu licenseType → LICENSE_TYPE_REQUIRED', () => {
    expect(() => validateSoftwareInput(sw)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'LICENSE_TYPE_REQUIRED' }),
      }),
    );
  });

  it('term thiếu endDate → LICENSE_END_DATE_REQUIRED', () => {
    expect(() =>
      validateSoftwareInput({ ...sw, licenseType: 'term', endDate: null }),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'LICENSE_END_DATE_REQUIRED',
        }),
      }),
    );
  });

  it('perpetual thiếu tên / có endDate → bị chặn; hợp lệ thì qua', () => {
    expect(() =>
      validateSoftwareInput({ ...sw, licenseType: 'perpetual' }),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'LICENSE_NAME_REQUIRED' }),
      }),
    );
    expect(() =>
      validateSoftwareInput({
        ...sw,
        licenseType: 'perpetual',
        licenseName: 'Windows 11 Pro',
        endDate: '2030-01-01',
      }),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'LICENSE_PERPETUAL_NO_END' }),
      }),
    );
    expect(() =>
      validateSoftwareInput({
        ...sw,
        licenseType: 'perpetual',
        licenseName: 'Windows 11 Pro',
        endDate: null,
      }),
    ).not.toThrow();
    expect(() =>
      validateSoftwareInput({
        ...sw,
        licenseType: 'term',
        endDate: '2027-01-01',
      }),
    ).not.toThrow();
  });

  it('non-software mang trường license → SOFTWARE_FIELDS_ONLY', () => {
    expect(() =>
      validateSoftwareInput({ ...baseInput, licenseType: 'term' }),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'SOFTWARE_FIELDS_ONLY' }),
      }),
    );
  });
});

describe('diffChanged', () => {
  it('bigint-string từ pg so với number input KHÔNG bị coi là đổi', () => {
    const changed = diffChanged(
      {
        old_code: baseInput.code,
        old_type: 'laptop',
        old_cost: '15000000',
        old_start_date: '2026-01-15',
        old_floor: '3',
      },
      baseInput,
    );
    expect(changed).toEqual({});
  });

  it('null → giá trị mới được ghi nhận from/to', () => {
    const changed = diffChanged(
      {
        old_code: baseInput.code,
        old_type: 'laptop',
        old_cost: '15000000',
        old_start_date: '2026-01-15',
        old_floor: '3',
        old_note: null,
      },
      { ...baseInput, note: 'máy trầy góc' },
    );
    expect(changed).toEqual({
      note: { from: null, to: 'máy trầy góc' },
    });
  });
});
