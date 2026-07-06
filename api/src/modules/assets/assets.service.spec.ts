import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { AssetsService, diffChanged } from './assets.service';
import type { AssetInput } from './assets.service';
import type { Database } from '../../database/database.module';
import type { AuditWriterService } from '../audit/audit-writer.service';

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
};

function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('pg error'), { code, constraint });
}

function makeService(db: Partial<Record<string, unknown>>) {
  const audit = { append: jest.fn().mockResolvedValue(undefined) };
  const svc = new AssetsService(
    db as unknown as Database,
    audit as unknown as AuditWriterService,
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
    expect(audit.append).not.toHaveBeenCalled();
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

  it('create: thành công → audit assets.create với actor/objectId', async () => {
    const created = { id: 'uuid-1', code: baseInput.code, type: 'laptop' };
    const db = {
      insert: () => ({
        values: () => ({ returning: () => Promise.resolve([created]) }),
      }),
    };
    const { svc, audit } = makeService(db);
    await svc.create(baseInput, 'admin-1');
    expect(audit.append).toHaveBeenCalledWith(
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
    expect(audit.append).not.toHaveBeenCalled();
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
    const db = { execute: () => Promise.resolve({ rows: [oldRow] }) };
    const { svc, audit } = makeService(db);
    const res = await svc.update(
      'uuid-1',
      { ...baseInput, cost: 20000000, assignedUserSub: 'sub-m1' },
      1,
      'admin-1',
    );
    expect(res).toEqual({ ok: true, version: 2 });
    const call = audit.append.mock.calls[0][0] as {
      detail: { changed: Record<string, unknown> };
    };
    expect(call.detail.changed).toEqual({
      cost: { from: '15000000', to: '20000000' },
      assigned_user_sub: { from: null, to: 'sub-m1' },
    });
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
