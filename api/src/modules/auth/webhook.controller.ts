import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Request } from 'express';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Database } from '../../database/database.module';
import { AuditWriterService } from '../audit/audit-writer.service';
import { UsersService } from '../users/users.service';
import { Public } from './public.decorator';
import { SessionService } from './session.service';

interface PmhWebhookEvent {
  type: string;
  user_id: string;
  groups?: string[];
  event_id?: string;
}

const KICK_EVENTS = new Set([
  'user.locked',
  'user.deleted',
  'user.password_changed',
]);
/** locked/deleted đổi users.status → scan offboarding (5.5) nhặt cascade + cảnh báo. */
const STATUS_BY_EVENT: Record<string, 'locked' | 'deleted'> = {
  'user.locked': 'locked',
  'user.deleted': 'deleted',
};

/**
 * Webhook PMH ID (NFR-11): verify HMAC-SHA256 trên RAW body TRƯỚC khi xử lý;
 * user.locked/deleted/password_changed → đá mọi phiên local tức thì.
 * Trả 2xx nhanh — PMH ID retry giãn dần khi lỗi.
 */
@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly users: UsersService,
    private readonly audit: AuditWriterService,
    @Inject(DRIZZLE_DB) private readonly db: Database,
  ) {}

  @Public()
  @Post('pmh-id')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-pmh-signature') signature: string | undefined,
  ): Promise<{ ok: boolean }> {
    const rawBody = req.rawBody;
    if (!rawBody || !this.verifySignature(rawBody, signature)) {
      await this.audit.append({
        actor: 'system',
        action: 'auth.webhook_rejected',
        detail: { reason: signature ? 'bad_signature' : 'missing_signature' },
      });
      throw new UnauthorizedException({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        message: 'Chữ ký webhook không hợp lệ.',
      });
    }

    // Chữ ký đúng nhưng payload hỏng → 400 (không 500 — PMH ID sẽ retry giãn dần
    // vào cùng payload hỏng mãi mãi)
    const event = this.parseEvent(rawBody);

    // Idempotent theo event_id (AC2): đã xử xong trước đó (replay) → bỏ qua. Check TRƯỚC + mark
    // SAU khi xử xong (không phải claim-trước): crash giữa chừng → retry xử lại (mọi mutation
    // idempotent: setStatus/destroyAllForUser/updateGroups) — không nuốt việc. Thiếu event_id
    // (payload cũ) → luôn xử, dựa marker offboard_alerted_at chống đúp ở tầng scan.
    if (event.event_id && (await this.isProcessed(event.event_id))) {
      return { ok: true };
    }

    if (KICK_EVENTS.has(event.type)) {
      const killed = await this.sessions.destroyAllForUser(event.user_id);
      // locked/deleted → set status ngay (NFR-11); scan offboarding (5.5) lo cascade + cảnh báo.
      const status = STATUS_BY_EVENT[event.type];
      if (status) await this.users.setStatus(event.user_id, status);
      await this.audit.append({
        actor: 'system(webhook)',
        action: 'auth.session_revoked',
        objectType: 'user',
        objectId: event.user_id,
        detail: { event: event.type, sessions_killed: killed, status },
      });
    } else if (event.type === 'user.groups_changed' && event.groups) {
      await this.users.updateGroups(event.user_id, event.groups);
    } else {
      this.logger.log(`Webhook event bỏ qua: ${event.type}`);
    }
    if (event.event_id) await this.markProcessed(event.event_id);
    return { ok: true };
  }

  /** Đã xử event này chưa (dedup replay sau khi hoàn tất). */
  private async isProcessed(eventId: string): Promise<boolean> {
    const r = await this.db.execute<{ event_id: string }>(sql`
      SELECT event_id FROM processed_webhook_events WHERE event_id = ${eventId}
    `);
    return r.rows.length === 1;
  }

  /** Đánh dấu đã xử xong (gọi SAU mutation). ON CONFLICT: 2 lần chạy song song không lỗi. */
  private async markProcessed(eventId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO processed_webhook_events (event_id) VALUES (${eventId})
      ON CONFLICT (event_id) DO NOTHING
    `);
  }

  private parseEvent(rawBody: Buffer): PmhWebhookEvent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      parsed = null;
    }
    const event = parsed as PmhWebhookEvent | null;
    if (
      !event ||
      typeof event !== 'object' ||
      typeof event.type !== 'string' ||
      typeof event.user_id !== 'string' ||
      (event.groups !== undefined && !Array.isArray(event.groups)) ||
      (event.event_id !== undefined && typeof event.event_id !== 'string')
    ) {
      throw new BadRequestException({
        code: 'WEBHOOK_PAYLOAD_INVALID',
        message: 'Payload webhook không đúng định dạng.',
      });
    }
    return event;
  }

  private verifySignature(
    rawBody: Buffer,
    signature: string | undefined,
  ): boolean {
    const secret = process.env.PMH_WEBHOOK_SECRET;
    if (!secret) {
      // Lỗi CẤU HÌNH, không phải client sai: mọi webhook bị reject → offboarding không chạy.
      // Log ERROR để đội vận hành thấy (audit M11), thay vì im lặng nuốt (prod đã chặn ở boot).
      this.logger.error(
        'PMH_WEBHOOK_SECRET chưa cấu hình — TỪ CHỐI mọi webhook (offboarding sẽ không kích hoạt).',
      );
      return false;
    }
    if (!signature) {
      return false;
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    // timingSafeEqual ném lỗi khi khác độ dài — coi như sai chữ ký, không throw
    return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
  }
}
