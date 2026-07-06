import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OIDC_PROVIDER } from '../auth/oidc-provider';
import type { OidcProvider } from '../auth/oidc-provider';

/** User từ Directory API (hợp đồng v1 — docs integration mục 5). `id` = claim `sub`. */
export interface DirectoryUser {
  id: string;
  employee_code?: string;
  email?: string;
  full_name?: string;
  status: 'active' | 'locked' | 'deleted';
  groups: string[];
}

export interface DirectoryGroup {
  id: string;
  name: string;
}

export const DIRECTORY_CLIENT = 'DIRECTORY_CLIENT';

export interface DirectoryClientApi {
  fetchUsers(): Promise<DirectoryUser[]>;
  fetchGroups(): Promise<DirectoryGroup[]>;
}

/** PMH_API_BASE suy từ PMH_ISSUER_URL bỏ path /oidc — không thêm env mới. */
function apiBase(): string {
  const issuer = new URL(process.env.PMH_ISSUER_URL as string);
  return `${issuer.protocol}//${issuer.host}`;
}

@Injectable()
export class DirectoryClient implements DirectoryClientApi {
  private readonly logger = new Logger(DirectoryClient.name);

  constructor(@Inject(OIDC_PROVIDER) private readonly oidc: OidcProvider) {}

  async fetchUsers(): Promise<DirectoryUser[]> {
    // include_deleted=true: đối soát offboarding (AC 1)
    const all: DirectoryUser[] = [];
    let page = 1;
    for (;;) {
      const body = await this.get(
        `/api/v1/users?include_deleted=true&page=${page}`,
      );
      const items = this.extractItems<DirectoryUser>(body);
      all.push(...items);
      // Hiện tại API trả mảng phẳng (đã test sống) → một vòng là đủ;
      // phòng thủ cho tương lai có phân trang: lặp tới trang rỗng
      if (!Array.isArray(body) && items.length > 0) {
        page += 1;
        continue;
      }
      break;
    }
    return all;
  }

  async fetchGroups(): Promise<DirectoryGroup[]> {
    const body = await this.get('/api/v1/groups');
    return this.extractItems<DirectoryGroup>(body);
  }

  private extractItems<T>(body: unknown): T[] {
    if (Array.isArray(body)) {
      return body as T[];
    }
    const obj = body as { data?: T[]; items?: T[] } | null;
    return obj?.data ?? obj?.items ?? [];
  }

  private async get(path: string): Promise<unknown> {
    let token: string;
    try {
      token = await this.oidc.clientCredentialsToken();
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
      this.logger.error(`Lấy token M2M thất bại: ${(error as Error).message}`);
      throw new BadGatewayException({
        code: 'DIRECTORY_AUTH_FAILED',
        message:
          'Không xác thực được với PMH ID (kiểm tra client_id/secret) — đồng bộ bị hủy.',
      });
    }
    let response: Response;
    try {
      response = await fetch(`${apiBase()}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      this.logger.error(
        `Directory API không liên lạc được: ${(error as Error).message}`,
      );
      throw new ServiceUnavailableException({
        code: 'DIRECTORY_UNAVAILABLE',
        message: 'Không liên lạc được Directory API PMH ID — thử lại sau.',
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new BadGatewayException({
        code: 'DIRECTORY_AUTH_FAILED',
        message: 'PMH ID từ chối token M2M — kiểm tra quyền client với SA.',
      });
    }
    if (!response.ok) {
      throw new ServiceUnavailableException({
        code: 'DIRECTORY_UNAVAILABLE',
        message: `Directory API lỗi (HTTP ${response.status}) — thử lại sau.`,
      });
    }
    return response.json();
  }
}
