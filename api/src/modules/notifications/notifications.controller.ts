import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { AuditWriterService } from '../audit/audit-writer.service';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { OutboxService } from '../outbox/outbox.service';

/**
 * Badge "X thông báo gửi lỗi" (AD-9/AD-11) — CHỈ Admin/SA (RolesGuard 403 member). Đọc marker
 * DLQ bền từ outbox (fail_count>0, chưa processed). Retry = CẮT VỀ BACKLOG (relay chạy lại),
 * không gọi SMTP trực tiếp trong request path.
 */
@Controller('admin/notifications')
@Roles('admin', 'sa')
export class NotificationsController {
  constructor(
    private readonly outbox: OutboxService,
    private readonly audit: AuditWriterService,
  ) {}

  @Get('failed')
  failed() {
    return this.outbox.listFailed();
  }

  /** Requeue tay: reset marker lỗi → relay re-drive. Ghi audit actor người bấm (AD-10). */
  @Post(':id/requeue')
  @HttpCode(200)
  async requeue(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    const ok = await this.outbox.requeue(id);
    if (!ok) {
      throw new NotFoundException('Thông báo không tồn tại hoặc đã xử lý.');
    }
    await this.audit.append({
      actor: req.user?.sub ?? 'unknown',
      action: 'notification.requeue',
      objectType: 'outbox',
      objectId: id,
    });
    return { ok: true };
  }
}
