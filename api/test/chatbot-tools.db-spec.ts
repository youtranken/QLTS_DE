import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 12.1 — lớp tool qua endpoint: quyền theo vai (G9), lọc ngày member (G2), cap 8 (G4). */
if (!process.env.DATABASE_URL) {
  throw new Error('[chatbot-tools.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[chatbot-tools.db-spec] Từ chối chạy '${dbName}'.`);
}

const asMember = { 'x-dev-user-sub': 'mem', 'x-dev-role': 'member' };
const asAdmin = { 'x-dev-user-sub': 'adm', 'x-dev-role': 'admin' };

interface ChatRes {
  cards: { code: string | null }[];
  total: number;
  source: string;
}

describe('Chatbot tools (quyền/lọc/cap) — story 12.1', () => {
  let app: INestApplication;
  let pool: Pool;

  const list = (headers: Record<string, string>, params: unknown) =>
    request(app.getHttpServer())
      .post('/api/chatbot/message')
      .set(headers)
      .send({ action: { intent: 'list_result', params } });

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    delete process.env.GEMINI_API_KEY;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS chat_messages, chat_conversations, department, outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role) VALUES
         ('adm','a@t.vn','Admin','admin'),
         ('mem','m@t.vn','Member','member'),
         ('oth','o@t.vn','Other','member')`,
    );
    // 9 laptop của mem (cap test), 2 pc của mem (type + date filter), 1 của oth, 1 chưa cấp phát
    await pool.query(
      `INSERT INTO assets (code, type, status, assigned_user_sub, end_date)
       SELECT 'M-0'||g, 'laptop','in_use','mem','2026-12-31' FROM generate_series(1,9) g`,
    );
    await pool.query(
      `INSERT INTO assets (code, type, status, assigned_user_sub, end_date) VALUES
         ('P-01','pc','in_use','mem','2026-08-31'),
         ('P-02','pc','in_use','mem','2026-12-31'),
         ('O-01','laptop','in_use','oth','2026-12-31'),
         ('U-01','laptop','in_use',NULL,'2026-12-31')`,
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('AC2 — member list rỗng-filter → CHỈ máy mình, cap 8, "hiển thị 8/tổng 11"', async () => {
    const res = await list(asMember, {}).expect(201);
    const body = res.body as ChatRes;
    expect(body.total).toBe(11);
    expect(body.cards).toHaveLength(8);
    const codes = body.cards.map((c) => c.code);
    expect(codes).not.toContain('O-01');
    expect(codes).not.toContain('U-01');
  });

  it('AC1 — member lọc type=pc → 2', async () => {
    const res = await list(asMember, { type: 'pc' }).expect(201);
    expect((res.body as ChatRes).total).toBe(2);
  });

  it('G2 — member lọc theo NGÀY (endTo) → P-01', async () => {
    const res = await list(asMember, {
      type: 'pc',
      endTo: '2026-09-30',
    }).expect(201);
    const body = res.body as ChatRes;
    expect(body.total).toBe(1);
    expect(body.cards[0].code).toBe('P-01');
  });

  it('G9 — member KHÔNG thấy máy người khác (search O-01 → 0)', async () => {
    const res = await list(asMember, { search: 'O-01' }).expect(201);
    expect((res.body as ChatRes).total).toBe(0);
  });

  it('AC1 — admin thấy TOÀN sổ (13 máy)', async () => {
    const res = await list(asAdmin, {}).expect(201);
    const body = res.body as ChatRes;
    expect(body.total).toBe(13);
    expect(body.cards).toHaveLength(8);
  });

  it('AC1 — admin thấy máy người khác (search O-01 → 1)', async () => {
    const res = await list(asAdmin, { search: 'O-01' }).expect(201);
    const body = res.body as ChatRes;
    expect(body.total).toBe(1);
    expect(body.cards[0].code).toBe('O-01');
  });
});
