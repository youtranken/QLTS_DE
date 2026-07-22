import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { createTestApp } from './test-app.helper';

/** Story 12.1 AC6 — lưu/đọc lịch sử theo sub + chống IDOR (A không chạm cuộc của B). */
if (!process.env.DATABASE_URL) {
  throw new Error('[chatbot-history.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[chatbot-history.db-spec] Từ chối chạy '${dbName}'.`);
}

const asA = { 'x-dev-user-sub': 'usrA', 'x-dev-role': 'member' };
const asB = { 'x-dev-user-sub': 'usrB', 'x-dev-role': 'member' };

describe('Chatbot lịch sử theo member (story 12.1 AC6)', () => {
  let app: INestApplication;
  let pool: Pool;

  const menu = (headers: Record<string, string>, conversationId?: string) =>
    request(app.getHttpServer())
      .post('/api/chatbot/message')
      .set(headers)
      .send({ conversationId, action: { intent: 'menu' } });

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

  it('tạo cuộc mới + ghi tiếp cùng cuộc + đọc message', async () => {
    const first = await menu(asA).expect(201);
    const cid = (first.body as { conversationId: string }).conversationId;
    expect(cid).toBeTruthy();

    await menu(asA, cid).expect(201);

    const convs = await request(app.getHttpServer())
      .get('/api/chatbot/conversations')
      .set(asA)
      .expect(200);
    expect((convs.body as unknown[]).length).toBe(1);

    const msgs = await request(app.getHttpServer())
      .get(`/api/chatbot/conversations/${cid}`)
      .set(asA)
      .expect(200);
    // 2 lượt × (user + assistant) = 4 message
    expect((msgs.body as unknown[]).length).toBe(4);
  });

  it('POST conversations tạo cuộc rỗng (sidebar +1)', async () => {
    await request(app.getHttpServer())
      .post('/api/chatbot/conversations')
      .set(asA)
      .expect(201);
    const convs = await request(app.getHttpServer())
      .get('/api/chatbot/conversations')
      .set(asA)
      .expect(200);
    expect((convs.body as unknown[]).length).toBe(2);
  });

  it('IDOR — B KHÔNG đọc/xoá được cuộc của A (404)', async () => {
    const a = await menu(asA).expect(201);
    const cid = (a.body as { conversationId: string }).conversationId;
    await request(app.getHttpServer())
      .get(`/api/chatbot/conversations/${cid}`)
      .set(asB)
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/chatbot/conversations/${cid}`)
      .set(asB)
      .expect(404);
  });

  it('A xoá cuộc của mình → 204, biến khỏi danh sách', async () => {
    const a = await menu(asA).expect(201);
    const cid = (a.body as { conversationId: string }).conversationId;
    await request(app.getHttpServer())
      .delete(`/api/chatbot/conversations/${cid}`)
      .set(asA)
      .expect(204);
    const convs = await request(app.getHttpServer())
      .get('/api/chatbot/conversations')
      .set(asA)
      .expect(200);
    const ids = (convs.body as { id: string }[]).map((c) => c.id);
    expect(ids).not.toContain(cid);
  });
});
