import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthedRequest } from '../modules/auth/identity.guard';

/**
 * Rate-limit theo USER (sub) thay vì IP (epic review 2) — sau nginx mọi request
 * cùng IP proxy, throttle theo IP sẽ gộp cả văn phòng vào một bucket.
 * Chạy SAU IdentityGuard (đăng ký ở AppModule — sau AuthModule) nên req.user có sẵn.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: AuthedRequest): Promise<string> {
    return Promise.resolve(req.user?.sub ?? req.ip ?? 'anonymous');
  }
}
