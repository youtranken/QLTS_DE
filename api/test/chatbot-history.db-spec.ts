import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 12.1 (redesign 1-luồng) — GET/DELETE /chatbot/history self-scoped, chống IDOR. */
if (!process.env.DATABASE_URL) {
  throw new Error('[chatbot-history.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[chatbot-history.db-spec] Từ chối chạy '${dbName}'.`);
}

const asA = { 'x-dev-user-sub': 'usrA', 'x-dev-role': 'member' };
const asB = { 'x-dev-user-sub': 'usrB', 'x-dev-role': 'member' };

interface Hist {
  conversationId: string;
  messages: unknown[];
}

describe('Chatbot lịch sử 1-luồng (story 12.1 redesign)', () => {
  let app: INestApplication;
  let pool: Pool;

  const msg = (headers: Record<string, string>, conversationId?: string) =>
    request(app.getHttpServer())
      .post('/api/chatbot/message')
      .set(headers)
      .send({ conversationId, action: { intent: 'my_assets' } });

  const getHistory = (headers: Record<string, string>) =>
    request(app.getHttpServer()).get('/api/chatbot/history').set(headers);

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
         ('usrA','a@t.vn','User A','member'),
         ('usrB','b@t.vn','User B','member')`,
    );
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('1 luồng: ghi tiếp cùng cuộc, mở lại thấy message cũ', async () => {
    const h0 = (await getHistory(asA).expect(200)).body as Hist;
    expect(h0.conversationId).toBeTruthy();
    expect(h0.messages).toHaveLength(0);

    const m1 = await msg(asA, h0.conversationId).expect(201);
    expect((m1.body as { conversationId: string }).conversationId).toBe(
      h0.conversationId,
    );
    await msg(asA, h0.conversationId).expect(201);

    const h1 = (await getHistory(asA).expect(200)).body as Hist;
    expect(h1.conversationId).toBe(h0.conversationId); // vẫn 1 luồng
    expect(h1.messages).toHaveLength(4); // 2 lượt × (user + assistant)
  });

  it('IDOR — B chỉ thấy luồng của B (rỗng), không thấy của A', async () => {
    const hB = (await getHistory(asB).expect(200)).body as Hist;
    const hA = (await getHistory(asA).expect(200)).body as Hist;
    expect(hB.conversationId).not.toBe(hA.conversationId);
    expect(hB.messages).toHaveLength(0);
  });

  it('DELETE /history → xoá sạch của mình, mở lại là luồng trống mới', async () => {
    await request(app.getHttpServer())
      .delete('/api/chatbot/history')
      .set(asA)
      .expect(204);
    const h = (await getHistory(asA).expect(200)).body as Hist;
    expect(h.messages).toHaveLength(0);
  });
});
