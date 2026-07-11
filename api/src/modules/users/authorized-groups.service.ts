import { Inject, Injectable, Logger } from '@nestjs/common';
import { SystemConfigService } from '../config/system-config.service';
import { DIRECTORY_CLIENT } from './directory.client';
import type { DirectoryClientApi } from './directory.client';

/**
 * Nguồn "group được phép vào QLTS" cho gate login (10.2/10.3).
 * - `current()`: đọc danh sách đã lưu (`config.authorized_groups`, do directory-sync ghi).
 * - `refreshForLogin()`: SELF-HEAL (10.3) — khi user login mang group CHƯA có trong danh sách
 *   (vd admin vừa gán group mới cho client mà chưa tới chu kỳ sync), fetch tươi `GET /api/v1/groups`
 *   MỘT lần rồi persist, để user hợp lệ vào được NGAY thay vì bị chặn oan tới ≤60'.
 *
 * Cache TTL ngắn chống lạm dụng: user sai-group cố login lặp không ép gọi M2M mỗi lần
 * (chỉ 1 fetch / TTL). PMH ID lỗi → dùng bản đã lưu (không mở toang, không chặn thêm).
 */
@Injectable()
export class AuthorizedGroupsService {
  private readonly logger = new Logger(AuthorizedGroupsService.name);
  private cached: { groups: string[]; expires: number } | null = null;
  private static readonly TTL_MS = 30_000;

  constructor(
    @Inject(DIRECTORY_CLIENT) private readonly directory: DirectoryClientApi,
    private readonly config: SystemConfigService,
  ) {}

  /** Danh sách hiện đã lưu (nguồn chính, luôn tươi từ DB). */
  current(): Promise<string[]> {
    return this.config.getAuthorizedGroups();
  }

  /**
   * Self-heal: fetch tươi group client được cấp (cache TTL), persist vào config, trả danh sách mới.
   * Lỗi fetch → trả bản đã lưu (fallback an toàn). Gọi ở gate login KHI check ban đầu trượt.
   */
  async refreshForLogin(): Promise<string[]> {
    if (this.cached && this.cached.expires > Date.now()) {
      return this.cached.groups;
    }
    try {
      const names = (await this.directory.fetchGroups()).map((g) => g.name);
      await this.config.setAuthorizedGroups(names);
      this.setCache(names);
      return names;
    } catch (error) {
      this.logger.warn(
        `self-heal fetchGroups lỗi (dùng bản đã lưu): ${(error as Error).message}`,
      );
      const fallback = await this.config.getAuthorizedGroups();
      // cache cả khi lỗi để không hammer PMH ID lúc đang sập
      this.setCache(fallback);
      return fallback;
    }
  }

  /** Reset cache (test / muốn hiệu lực ngay) — theo mẫu SystemConfigService.clearCache. */
  clearCache(): void {
    this.cached = null;
  }

  private setCache(groups: string[]): void {
    this.cached = {
      groups,
      expires: Date.now() + AuthorizedGroupsService.TTL_MS,
    };
  }
}
