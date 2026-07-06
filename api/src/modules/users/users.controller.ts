import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import type { AuthedRequest } from '../auth/identity.guard';
import { DirectorySyncService } from './directory-sync.service';
import type { DirectorySyncResult } from './directory-sync.service';
import { DIRECTORY_CLIENT } from './directory.client';
import type { DirectoryClientApi, DirectoryGroup } from './directory.client';
import { Inject } from '@nestjs/common';

@Controller('admin/directory-sync')
export class UsersController {
  constructor(
    private readonly directorySync: DirectorySyncService,
    @Inject(DIRECTORY_CLIENT) private readonly directory: DirectoryClientApi,
  ) {}

  /** SA bấm "Đồng bộ ngay" (AC 1) — cần CSRF khi gọi từ phiên cookie. */
  @Post()
  @HttpCode(200)
  @Roles('sa')
  sync(@Req() req: AuthedRequest): Promise<DirectorySyncResult> {
    return this.directorySync.sync(req.user?.sub ?? 'system');
  }

  /** Xem trước phạm vi group client đang thấy mà không cần sync (AC 3). */
  @Get('groups')
  @Roles('sa')
  groups(): Promise<DirectoryGroup[]> {
    return this.directory.fetchGroups();
  }
}
