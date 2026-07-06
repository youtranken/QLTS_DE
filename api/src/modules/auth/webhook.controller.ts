import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AuditWriterService } from '../audit/audit-writer.service';
import { UsersService } from '../users/users.service';
import { Public } from './public.decorator';
import { SessionService } from './session.service';

interface PmhWebhookEvent {
  type: string;
  user_id: string;
  groups?: string[];
}

const KICK_EVENTS = new Set([
  'user.locked',
  'user.deleted',
  'user.password_changed',
]);

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
    if (KICK_EVENTS.has(event.type)) {
      const killed = await this.sessions.destroyAllForUser(event.user_id);
      await this.audit.append({
        actor: 'system',
        action: 'auth.session_revoked',
        objectType: 'user',
        objectId: event.user_id,
        detail: { event: event.type, sessions_killed: killed },
      });
    } else if (event.type === 'user.groups_changed' && event.groups) {
      await this.users.updateGroups(event.user_id, event.groups);
    } else {
      this.logger.log(`Webhook event bỏ qua: ${event.type}`);
    }
    return { ok: true };
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
      (event.groups !== undefined && !Array.isArray(event.groups))
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
    if (!secret || !signature) {
      return false;
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    // timingSafeEqual ném lỗi khi khác độ dài — coi như sai chữ ký, không throw
    return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
  }
}
