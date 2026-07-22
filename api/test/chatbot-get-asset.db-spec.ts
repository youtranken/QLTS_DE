import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { runMigrations } from '../src/database/migration-runner';
import type { Database } from '../src/database/database.module';
import { ChatbotToolsService } from '../src/modules/chatbot/chatbot-tools.service';
import type { AssetsService } from '../src/modules/assets/assets.service';
import type { AssetSoftwareService } from '../src/modules/assets/asset-software.service';
import type { BookingService } from '../src/modules/booking/booking.service';
import type { TicketsService } from '../src/modules/tickets/tickets.service';
import type { ExtensionService } from '../src/modules/tickets/extension.service';
import type { Identity } from '../src/modules/chatbot/chatbot.types';

const stub = <T>() => ({}) as unknown as T;

/** Story 12.x — get_asset: chỉ trả khía cạnh được hỏi + khối phần mềm tách + member self-scope. */
if (!process.env.DATABASE_URL) {
  throw new Error('[chatbot-get-asset.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[chatbot-get-asset.db-spec] Từ chối chạy '${dbName}'.`);
}

const MEM: Identity = { sub: 'mem', role: 'member' };

describe('Chatbot get_asset (chi tiết theo khía cạnh)', () => {
  let pool: Pool;
  let tools: ChatbotToolsService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS chat_messages, chat_conversations, department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES
         ('mem','m@t.vn','Member','member'),
         ('oth','o@t.vn','Other','member')`,
    );
    // Máy của mem: có cấu hình + giá + vị trí + 1 phần mềm; 1 máy của người khác.
    await pool.query(
      `INSERT INTO assets (code, type, status, assigned_user_sub, configuration, cost, floor)
       VALUES ('M-01','Laptop','in_use','mem','i5/16GB/512GB', 15000000, 'Tầng 3')`,
    );
    await pool.query(
      `INSERT INTO assets (code, type, status, assigned_user_sub) VALUES ('O-01','Laptop','in_use','oth')`,
    );
    await pool.query(
      `INSERT INTO assets (type, status, license_type, license_name, installed_on_asset_id)
       SELECT 'software','in_use','perpetual','Office 365', id FROM assets WHERE code='M-01'`,
    );

    // Lịch sử cấp phát cho M-01 (test asset_history).
    await pool.query(
      `INSERT INTO allocation_history (asset_id, from_user_sub, to_user_sub, actor, note)
       SELECT id, NULL, 'mem', 'import-seed', 'giao máy ban đầu' FROM assets WHERE code='M-01'`,
    );

    const db = drizzle(pool) as unknown as Database;
    tools = new ChatbotToolsService(
      db,
      stub<AssetsService>(),
      stub<BookingService>(),
      stub<TicketsService>(),
      stub<ExtensionService>(),
      stub<AssetSoftwareService>(),
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('hỏi CẤU HÌNH → chỉ row Cấu hình, KHÔNG kèm phần mềm', async () => {
    const d = await tools.getAsset(MEM, 'M-01', ['config']);
    expect(d?.rows).toEqual([{ label: 'Cấu hình', value: 'i5/16GB/512GB' }]);
    expect(d?.software).toBeNull();
  });

  it('hỏi GIÁ → chỉ row Giá (định dạng dấu chấm)', async () => {
    const d = await tools.getAsset(MEM, 'M-01', ['price']);
    expect(d?.rows).toHaveLength(1);
    expect(d?.rows[0].label).toBe('Giá');
    expect(d?.rows[0].value).toContain('15.000.000');
  });

  it('hỏi PHẦN MỀM → khối software tách, có Office 365', async () => {
    const d = await tools.getAsset(MEM, 'M-01', ['software']);
    expect(d?.rows).toEqual([]);
    expect(d?.software).toEqual(['Office 365']);
  });

  it('hỏi cấu hình + vị trí + phần mềm → đủ 2 row + software', async () => {
    const d = await tools.getAsset(MEM, 'M-01', [
      'config',
      'place',
      'software',
    ]);
    expect(d?.rows.map((r) => r.label)).toEqual(['Cấu hình', 'Vị trí']);
    expect(d?.software).toEqual(['Office 365']);
  });

  it('member KHÔNG xem được máy người khác → null', async () => {
    expect(await tools.getAsset(MEM, 'O-01', ['config'])).toBeNull();
  });

  it('mã không tồn tại → null', async () => {
    expect(await tools.getAsset(MEM, 'X-99', ['config'])).toBeNull();
  });

  it('asset_history: máy mình → có lịch sử cấp phát', async () => {
    const h = await tools.assetHistory(MEM, 'M-01');
    expect(h?.code).toBe('M-01');
    expect(h?.lichSu).toHaveLength(1);
    expect(h?.lichSu[0].den).toBe('Member'); // to_user_sub='mem' → full_name 'Member'
    expect(h?.lichSu[0].boi).toBe('import-seed'); // actor không phải sub → raw
  });

  it('asset_history: member KHÔNG xem máy người khác → null', async () => {
    expect(await tools.assetHistory(MEM, 'O-01')).toBeNull();
  });
});
