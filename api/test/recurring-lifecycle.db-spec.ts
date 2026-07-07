import type { INestApplication } from '@nestjs/common';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { runMigrations } from '../src/database/migration-runner';
import { RecurringLifecycleService } from '../src/modules/tickets/recurring-lifecycle.service';
import { RecurringService } from '../src/modules/tickets/recurring.service';
import { TicketsService } from '../src/modules/tickets/tickets.service';
import { createTestApp } from './test-app.helper';

/** Story 4.5a/4.5b — duyệt chuỗi, giao-nhận từng buổi, no-show per-buổi, state cha tổng hợp. */
if (!process.env.DATABASE_URL) {
  throw new Error('[recurring-lifecycle.db-spec] DATABASE_URL chưa đặt.');
}
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!/test/i.test(dbName)) {
  throw new Error(`[recurring-lifecycle.db-spec] Từ chối chạy trên '${dbName}'.`);
}

const asAdmin = { 'x-dev-user-sub': 'adm-l', 'x-dev-role': 'admin' };
const asMem = { 'x-dev-user-sub': 'mem-l', 'x-dev-role': 'member' };

describe('Vòng đời chuỗi định kỳ (story 4.5a/4.5b)', () => {
  let app: INestApplication;
  let pool: Pool;
  let life: RecurringLifecycleService;
  let recurring: RecurringService;
  let tickets: TicketsService;

  const newMachine = async (code: string) => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO assets (code, type, is_pool, status) VALUES ($1,'laptop',true,'in_use') RETURNING id`,
      [code],
    );
    return r.rows[0].id;
  };

  /** Tạo chuỗi pending_approval với N buổi held (khung tương lai không chồng). */
  const seedChain = async (assetId: string, offsets: number[]) => {
    const t = await pool.query<{ id: string; version: number }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub) VALUES ('recurring','pending_approval','mem-l','mem-l') RETURNING id, version`,
    );
    const bookings: { id: string; version: number }[] = [];
    for (const d of offsets) {
      const b = await pool.query<{ id: string; version: number }>(
        `INSERT INTO booking (ticket_id, asset_id, kind, state, period)
         VALUES ($1,$2,'recurring','held', tstzrange(now()+($3||' days')::interval, now()+($3||' days 2 hours')::interval,'[)'))
         RETURNING id, version`,
        [t.rows[0].id, assetId, d],
      );
      bookings.push(b.rows[0]);
    }
    return { ticketId: t.rows[0].id, version: t.rows[0].version, bookings };
  };

  const ticketState = async (id: string) => {
    const r = await pool.query<{
      state: string;
      is_overdue: boolean;
      version: number;
      reject_reason: string | null;
    }>(`SELECT state, is_overdue, version, reject_reason FROM ticket WHERE id=$1`, [
      id,
    ]);
    return r.rows[0];
  };
  const bookingRow = async (id: string) => {
    const r = await pool.query<{ state: string; version: number }>(
      `SELECT state, version FROM booking WHERE id=$1`,
      [id],
    );
    return r.rows[0];
  };

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      'DROP TABLE IF EXISTS outbox, ticket_file, booking, ticket, inventory_round_files, inventory_rounds, files, asset_note, allocation_history, assets, sessions, audit_log, users, config, _migrations CASCADE',
    );
    await runMigrations(pool, join(__dirname, '..', 'src', 'migrations'), {
      log: () => undefined,
    });
    await pool.query(
      `INSERT INTO users (sub, email, full_name, role, can_recurring) VALUES
        ('mem-l','l@t.vn','Member L','member', true),
        ('adm-l','a@t.vn','Admin L','admin', true)`,
    );
    app = await createTestApp();
    life = app.get(RecurringLifecycleService);
    recurring = app.get(RecurringService);
    tickets = app.get(TicketsService);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.AUTH_DEV_MODE;
  });

  it('AC1: approveChain — mọi buổi held→pending, cha → awaiting_pickup', async () => {
    const m = await newMachine('LC-1');
    const c = await seedChain(m, [2, 9]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    expect((await ticketState(c.ticketId)).state).toBe('awaiting_pickup');
    for (const b of c.bookings) {
      expect((await bookingRow(b.id)).state).toBe('pending');
    }
  });

  it('AC1: approveChain sai version → STALE_VERSION', async () => {
    const m = await newMachine('LC-2');
    const c = await seedChain(m, [3]);
    await expect(
      life.approveChain(c.ticketId, c.version + 5, 'adm-l'),
    ).rejects.toMatchObject({ response: { code: 'STALE_VERSION' } });
  });

  it('AC1: rejectChain — buổi cancelled, cha → rejected + lý do', async () => {
    const m = await newMachine('LC-3');
    const c = await seedChain(m, [4, 11]);
    await life.rejectChain(c.ticketId, c.version, 'Không đủ thiết bị', 'adm-l');
    const t = await ticketState(c.ticketId);
    expect(t.state).toBe('rejected');
    expect(t.reject_reason).toBe('Không đủ thiết bị');
    for (const b of c.bookings) {
      expect((await bookingRow(b.id)).state).toBe('cancelled');
    }
  });

  it('AC2: bảng chân trị deliver/return — in_use → awaiting_pickup → closed', async () => {
    const m = await newMachine('LC-4');
    const c = await seedChain(m, [2, 9]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    const [s1, s2] = c.bookings;

    // giao buổi 1 → có delivered → in_use
    await life.deliverSession(s1.id, (await bookingRow(s1.id)).version, null, [], 'adm-l');
    expect((await ticketState(c.ticketId)).state).toBe('in_use');

    // nhận buổi 1 → còn buổi 2 pending → awaiting_pickup
    await life.returnSession(s1.id, (await bookingRow(s1.id)).version, 'Máy OK', [], 'adm-l');
    expect((await ticketState(c.ticketId)).state).toBe('awaiting_pickup');

    // giao & nhận buổi 2 → mọi buổi terminal, có returned → closed
    await life.deliverSession(s2.id, (await bookingRow(s2.id)).version, null, [], 'adm-l');
    await life.returnSession(s2.id, (await bookingRow(s2.id)).version, 'Xong', [], 'adm-l');
    expect((await ticketState(c.ticketId)).state).toBe('closed');
  });

  it('AC2: returnSession không note → NOTE_REQUIRED', async () => {
    const m = await newMachine('LC-5');
    const c = await seedChain(m, [2]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    const s = c.bookings[0];
    await life.deliverSession(s.id, (await bookingRow(s.id)).version, null, [], 'adm-l');
    await expect(
      life.returnSession(s.id, (await bookingRow(s.id)).version, '  ', [], 'adm-l'),
    ).rejects.toMatchObject({ response: { code: 'NOTE_REQUIRED' } });
  });

  it('AC3: no-show per-buổi — buổi pending quá giờ → chỉ buổi đó cancelled, buổi khác còn', async () => {
    const m = await newMachine('LC-6');
    // buổi 1 khung quá khứ (đã duyệt pending, không ai đến nhận); buổi 2 tương lai
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub) VALUES ('recurring','awaiting_pickup','mem-l','mem-l') RETURNING id`,
    );
    const past = await pool.query<{ id: string }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES
        ($1,$2,'recurring','pending', tstzrange(now()-interval '3 hours', now()-interval '1 hour','[)')) RETURNING id`,
      [t.rows[0].id, m],
    );
    const future = await pool.query<{ id: string }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES
        ($1,$2,'recurring','pending', tstzrange(now()+interval '7 days', now()+interval '7 days 2 hours','[)')) RETURNING id`,
      [t.rows[0].id, m],
    );
    const n = await life.autoCloseNoShowRecurringSessions();
    expect(n).toBe(1);
    expect((await bookingRow(past.rows[0].id)).state).toBe('cancelled');
    expect((await bookingRow(future.rows[0].id)).state).toBe('pending');
    // còn 1 buổi pending → cha vẫn awaiting_pickup
    expect((await ticketState(t.rows[0].id)).state).toBe('awaiting_pickup');
  });

  it('AC3 (rollup overdue): buổi delivered quá hạn → cha in_use + is_overdue', async () => {
    const m = await newMachine('LC-7');
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub) VALUES ('recurring','in_use','mem-l','mem-l') RETURNING id`,
    );
    // 1 buổi delivered đã quá hạn trả (khung KHÔNG chồng buổi pending bên dưới)
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES
        ($1,$2,'recurring','delivered', tstzrange(now()-interval '5 hours', now()-interval '3 hours','[)'))`,
      [t.rows[0].id, m],
    );
    // buổi pending quá giờ để kích deriveParentState (sweep cancel buổi này, không đụng delivered)
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES
        ($1,$2,'recurring','pending', tstzrange(now()-interval '2 hours', now()-interval '1 hour','[)'))`,
      [t.rows[0].id, m],
    );
    await life.autoCloseNoShowRecurringSessions();
    const st = await ticketState(t.rows[0].id);
    expect(st.state).toBe('in_use');
    expect(st.is_overdue).toBe(true);
  });

  it('AC3 (concurrency): nhận 2 buổi cuối song song → cha closed đúng 1 lần', async () => {
    const m = await newMachine('LC-8');
    const c = await seedChain(m, [2, 9]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    const [s1, s2] = c.bookings;
    await life.deliverSession(s1.id, (await bookingRow(s1.id)).version, null, [], 'adm-l');
    await life.deliverSession(s2.id, (await bookingRow(s2.id)).version, null, [], 'adm-l');
    const v1 = (await bookingRow(s1.id)).version;
    const v2 = (await bookingRow(s2.id)).version;
    // FOR UPDATE cha serial hóa deriveParentState → không lost-update
    await Promise.all([
      life.returnSession(s1.id, v1, 'A', [], 'adm-l'),
      life.returnSession(s2.id, v2, 'B', [], 'adm-l'),
    ]);
    expect((await ticketState(c.ticketId)).state).toBe('closed');
  });

  it('AC2 (queue read): listSessionQueue trả buổi pending + delivered', async () => {
    const m = await newMachine('LC-9');
    const c = await seedChain(m, [2, 9]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    await life.deliverSession(
      c.bookings[0].id,
      (await bookingRow(c.bookings[0].id)).version,
      null,
      [],
      'adm-l',
    );
    const q = await recurring.listSessionQueue();
    const ids = q.filter((s) => s.ticketId === c.ticketId).map((s) => s.state).sort();
    expect(ids).toEqual(['delivered', 'pending']);
  });

  it('AC1 (controller): POST recurring/:id/approve + reject qua route admin', async () => {
    const m = await newMachine('LC-10');
    const c = await seedChain(m, [3, 10]);
    const v = c.version;
    await request(app.getHttpServer())
      .post(`/api/admin/tickets/recurring/${c.ticketId}/approve`)
      .set(asAdmin)
      .send({ version: v })
      .expect(200);
    expect((await ticketState(c.ticketId)).state).toBe('awaiting_pickup');
  });

  it('H1: parent recurring KHÔNG lọt queue ticket-level & chặn deliver ticket-level', async () => {
    const m = await newMachine('LC-12');
    const c = await seedChain(m, [2, 9]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    // parent awaiting_pickup nhưng KHÔNG hiện trong queue giao ticket-level (chỉ kind=normal)
    const q = await tickets.listQueue('awaiting_pickup');
    expect(q.some((r) => r.id === c.ticketId)).toBe(false);
    // giao qua luồng ticket-level → chặn (không bulk-transition cả chuỗi)
    const t = await ticketState(c.ticketId);
    await expect(
      tickets.deliver(c.ticketId, t.version, null, [], 'adm-l'),
    ).rejects.toMatchObject({ response: { code: 'IS_RECURRING' } });
    // mọi buổi vẫn pending (không bị nhảy delivered)
    for (const b of c.bookings) {
      expect((await bookingRow(b.id)).state).toBe('pending');
    }
  });

  it('4.3 guard: chuỗi định kỳ KHÔNG gia hạn từng buổi (my-tickets extension → 409)', async () => {
    const m = await newMachine('LC-11');
    const t = await pool.query<{ id: string; version: number }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub) VALUES ('recurring','in_use','mem-l','mem-l') RETURNING id, version`,
    );
    await pool.query(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES
        ($1,$2,'recurring','delivered', tstzrange(now()-interval '1 hour', now()+interval '1 hour','[)'))`,
      [t.rows[0].id, m],
    );
    const res = await request(app.getHttpServer())
      .post(`/api/booking/my-tickets/${t.rows[0].id}/extension`)
      .set(asMem)
      .send({
        newDue: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        version: t.rows[0].version,
      })
      .expect(409);
    expect((res.body as { code: string }).code).toBe('INVALID_STATE');
  });

  // --- 4.6: member/admin hủy buổi lẻ ---------------------------------------

  it('4.6 AC1: member hủy buổi tương lai → chỉ buổi đó cancelled, buổi khác giữ', async () => {
    const m = await newMachine('LC-13');
    const c = await seedChain(m, [2, 9]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    const [s1, s2] = c.bookings;
    const v1 = (await bookingRow(s1.id)).version;
    await life.cancelSession(s1.id, v1, 'mem-l', false);
    expect((await bookingRow(s1.id)).state).toBe('cancelled');
    expect((await bookingRow(s2.id)).state).toBe('pending');
    // còn 1 buổi pending → cha awaiting_pickup
    expect((await ticketState(c.ticketId)).state).toBe('awaiting_pickup');
  });

  it('4.6 AC1: member hủy buổi ĐÃ tới giờ nhận → PICKUP_PASSED', async () => {
    const m = await newMachine('LC-14');
    // buổi pending khung quá khứ (đã tới giờ nhận)
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub) VALUES ('recurring','awaiting_pickup','mem-l','mem-l') RETURNING id`,
    );
    const b = await pool.query<{ id: string; version: number }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES
        ($1,$2,'recurring','pending', tstzrange(now()-interval '1 hour', now()+interval '1 hour','[)')) RETURNING id, version`,
      [t.rows[0].id, m],
    );
    await expect(
      life.cancelSession(b.rows[0].id, b.rows[0].version, 'mem-l', false),
    ).rejects.toMatchObject({ response: { code: 'PICKUP_PASSED' } });
  });

  it('4.6 AC1: buổi đã delivered → CANNOT_CANCEL_SESSION', async () => {
    const m = await newMachine('LC-15');
    const c = await seedChain(m, [2, 9]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    const s1 = c.bookings[0];
    await life.deliverSession(s1.id, (await bookingRow(s1.id)).version, null, [], 'adm-l');
    await expect(
      life.cancelSession(s1.id, (await bookingRow(s1.id)).version, 'mem-l', false),
    ).rejects.toMatchObject({ response: { code: 'CANNOT_CANCEL_SESSION' } });
  });

  it('4.6 AC3 (IDOR): member khác hủy buổi không phải của mình → 403', async () => {
    const m = await newMachine('LC-16');
    const c = await seedChain(m, [3, 10]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    const s = c.bookings[0];
    await expect(
      life.cancelSession(s.id, (await bookingRow(s.id)).version, 'someone-else', false),
    ).rejects.toMatchObject({ response: { code: 'NOT_TICKET_OWNER' } });
  });

  it('4.6 AC3: Admin hủy buổi CHƯA giao sau giờ nhận → được', async () => {
    const m = await newMachine('LC-17');
    const t = await pool.query<{ id: string }>(
      `INSERT INTO ticket (kind, state, borrower_sub, created_by_sub) VALUES ('recurring','awaiting_pickup','mem-l','mem-l') RETURNING id`,
    );
    const past = await pool.query<{ id: string; version: number }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES
        ($1,$2,'recurring','pending', tstzrange(now()-interval '2 hours', now()-interval '1 hour','[)')) RETURNING id, version`,
      [t.rows[0].id, m],
    );
    const future = await pool.query<{ id: string }>(
      `INSERT INTO booking (ticket_id, asset_id, kind, state, period) VALUES
        ($1,$2,'recurring','pending', tstzrange(now()+interval '7 days', now()+interval '7 days 2 hours','[)')) RETURNING id`,
      [t.rows[0].id, m],
    );
    await life.cancelSession(past.rows[0].id, past.rows[0].version, 'adm-l', true);
    expect((await bookingRow(past.rows[0].id)).state).toBe('cancelled');
    expect((await bookingRow(future.rows[0].id)).state).toBe('pending');
  });

  it('4.6 AC2: hủy buổi cuối khi ĐÃ từng giao 1 buổi → cha closed', async () => {
    const m = await newMachine('LC-18');
    const c = await seedChain(m, [2, 9]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    const [s1, s2] = c.bookings;
    // buổi 1 giao rồi nhận (từng delivered → returned)
    await life.deliverSession(s1.id, (await bookingRow(s1.id)).version, null, [], 'adm-l');
    await life.returnSession(s1.id, (await bookingRow(s1.id)).version, 'OK', [], 'adm-l');
    // hủy buổi 2 (buổi còn lại duy nhất) → mọi buổi terminal, ≥1 returned → closed
    await life.cancelSession(s2.id, (await bookingRow(s2.id)).version, 'mem-l', false);
    expect((await ticketState(c.ticketId)).state).toBe('closed');
  });

  it('4.6 AC2: hủy sạch khi CHƯA giao buổi nào → cha cancelled + quota nhả', async () => {
    const m = await newMachine('LC-19');
    const c = await seedChain(m, [2, 9]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    for (const s of c.bookings) {
      await life.cancelSession(s.id, (await bookingRow(s.id)).version, 'mem-l', false);
    }
    expect((await ticketState(c.ticketId)).state).toBe('cancelled');
    // quota nhả: không còn booking occupying
    const occ = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM booking WHERE ticket_id=$1 AND state IN ('held','pending','delivered')`,
      [c.ticketId],
    );
    expect(occ.rows[0].n).toBe(0);
  });

  it('4.6 (controller): member hủy buổi qua POST /booking/sessions/:id/cancel', async () => {
    const m = await newMachine('LC-20');
    const c = await seedChain(m, [3, 10]);
    await life.approveChain(c.ticketId, c.version, 'adm-l');
    const s = c.bookings[0];
    await request(app.getHttpServer())
      .post(`/api/booking/sessions/${s.id}/cancel`)
      .set(asMem)
      .send({ version: (await bookingRow(s.id)).version })
      .expect(200);
    expect((await bookingRow(s.id)).state).toBe('cancelled');
  });
});
