import { Injectable, OnModuleInit } from '@nestjs/common';
import { SweepService } from '../queue/sweep.service';
import { AssetsService } from './assets.service';

/**
 * Đăng ký sweep của Assets vào SweepService (AD-9). Chạy ở worker (SWEEP worker gọi runAll).
 * Auto-unlock (0036): máy pool khóa sửa chữa tới ngày ETA → tự mở khóa để mượn lại.
 */
@Injectable()
export class AssetsSweepRegistrar implements OnModuleInit {
  constructor(
    private readonly sweep: SweepService,
    private readonly assets: AssetsService,
  ) {}

  onModuleInit(): void {
    this.sweep.register({
      name: 'auto-unlock-expired',
      run: async () => {
        await this.assets.autoUnlockExpiredLocks();
      },
    });
  }
}
