import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import type { AuthedRequest } from '../auth/identity.guard';
import { DirectorySyncService } from './directory-sync.service';
import type { DirectorySyncResult } from './directory-sync.service';
import { DIRECTORY_CLIENT } from './directory.client';
import type { DirectoryClientApi, DirectoryGroup } from './directory.client';

/** @Roles cấp CLASS: SA + Admin (delegation 10.1). Handler mới kế thừa mặc định này. */
@Roles('sa', 'admin')
@Controller('admin/directory-sync')
export class UsersController {
  constructor(
    private readonly directorySync: DirectorySyncService,
    @Inject(DIRECTORY_CLIENT) private readonly directory: DirectoryClientApi,
  ) {}

  /** SA bấm "Đồng bộ ngay" (AC 1) — cần CSRF khi gọi từ phiên cookie. */
  @Post()
  @HttpCode(200)
  sync(@Req() req: AuthedRequest): Promise<DirectorySyncResult> {
    if (!req.user) {
      // IdentityGuard đã chặn — throw thay vì fallback 'system' để không làm giả actor audit
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Chưa đăng nhập.',
      });
    }
    return this.directorySync.sync(req.user.sub);
  }

  /** Xem trước phạm vi group client đang thấy mà không cần sync (AC 3). */
  @Get('groups')
  groups(): Promise<DirectoryGroup[]> {
    return this.directory.fetchGroups();
  }
}
