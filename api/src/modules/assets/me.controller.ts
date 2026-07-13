import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { MeService } from './me.service';

/**
 * UP-5.2: hồ sơ "của tôi". Mọi vai đăng nhập đều có (member xem máy mình giữ; admin/sa
 * xem của chính mình). Self-scoped tuyệt đối theo req.user.sub — KHÔNG param id.
 */
@Controller('me')
@Roles('member', 'admin', 'sa')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get('assets')
  assets(@Req() req: AuthedRequest) {
    if (!req.user) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Chưa đăng nhập.',
      });
    }
    return this.me.getMyAssets(req.user.sub);
  }
}
