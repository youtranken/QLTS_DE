import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SystemConfigService } from '../config/system-config.service';
import { SweepService } from '../queue/sweep.service';
import { DirectorySyncService } from './directory-sync.service';

/**
 * Sync danh bạ ĐỊNH KỲ (5.5, AC1, AD-9). Đăng ký sweep handler chạy full-sync mỗi
 * `directory_sync_interval_minutes` (config) — nhịp DERIVE từ marker `directory_sync_last_at`
 * trong DB, không tin cron slot. Job idempotent (upsert ON CONFLICT của 1.3). Lỗi cô lập
 * (sweep.runAll không chặn handler khác), log để giám sát.
 *
 * Deferred (party phiên 7): polling incremental `/events?since=cursor` + 410 Gone → full resync.
 * Hiện dùng full-sync (1.3 đã phát hiện đủ locked/deleted cho scan offboarding).
 */
@Injectable()
export class DirectorySyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(DirectorySyncScheduler.name);

  constructor(
    private readonly sweep: SweepService,
    private readonly config: SystemConfigService,
    private readonly directorySync: DirectorySyncService,
  ) {}

  onModuleInit(): void {
    this.sweep.register({
      name: 'directory-sync-periodic',
      run: () => this.runIfDue(),
    });
  }

  private async runIfDue(): Promise<void> {
    const intervalMs =
      (await this.config.getDirectorySyncIntervalMinutes()) * 60_000;
    const lastAt = await this.config.getDirectorySyncLastAt();
    if (lastAt && Date.now() - lastAt.getTime() < intervalMs) return;
    // Set mốc TRƯỚC khi chạy → tick kế trong interval không double-run; lỗi thì đợi interval sau.
    await this.config.setDirectorySyncLastAt(new Date());
    try {
      const r = await this.directorySync.sync('system');
      this.logger.log(
        `sync định kỳ: total=${r.total} +${r.created} ~${r.updated}`,
      );
    } catch (e) {
      this.logger.error(`sync định kỳ lỗi: ${(e as Error).message}`);
    }
  }
}
