import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { runMigrations } from './migration-runner';

describe('runMigrations — validate format tên file (trước khi chạm DB)', () => {
  it('tên không zero-pad NNNN_ → throw, pool không bị gọi', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qlts-mig-'));
    await writeFile(join(dir, '10_bad.sql'), 'SELECT 1;');
    const pool = {
      connect: jest.fn(),
    } as unknown as Pool;

    await expect(runMigrations(pool, dir)).rejects.toThrow(/sai format NNNN_/);
    expect(
      (pool as unknown as { connect: jest.Mock }).connect,
    ).not.toHaveBeenCalled();
  });
});

describe('runMigrations — marker "-- qlts:no-transaction" (story 3.1a, action item epic-2 review)', () => {
  function fakePool(queries: string[]) {
    const client = {
      query: jest.fn((text: unknown) => {
        if (typeof text === 'string') queries.push(text);
        // journal SELECT trả rỗng → file được coi là chưa apply
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: jest.fn(),
    };
    return { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
  }

  it('file KHÔNG marker → wrap BEGIN/COMMIT như cũ', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qlts-mig-'));
    await writeFile(join(dir, '0001_normal.sql'), 'SELECT 1;');
    const queries: string[] = [];
    await runMigrations(fakePool(queries), dir, { log: () => undefined });
    expect(queries).toContain('BEGIN');
    expect(queries).toContain('COMMIT');
  });

  it('file CÓ marker dòng đầu → chạy KHÔNG BEGIN/COMMIT, journal vẫn ghi', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qlts-mig-'));
    await writeFile(
      join(dir, '0001_no_tx.sql'),
      '-- qlts:no-transaction\nSELECT 1;',
    );
    const queries: string[] = [];
    await runMigrations(fakePool(queries), dir, { log: () => undefined });
    expect(queries).not.toContain('BEGIN');
    expect(queries).not.toContain('COMMIT');
    expect(queries.some((q) => q.includes('INSERT INTO _migrations'))).toBe(
      true,
    );
  });
});
