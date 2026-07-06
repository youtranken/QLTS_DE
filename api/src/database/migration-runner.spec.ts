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
