import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  Length,
  Matches,
  Min,
} from 'class-validator';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { TicketsService } from './tickets.service';

const trim = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value,
);

class VersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;
}

class LockAssetDto extends VersionDto {
  @trim
  @Length(1, 500)
  reason!: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'eta phải dạng YYYY-MM-DD' })
  eta?: string | null;
}

class SetPoolDto extends VersionDto {
  @IsBoolean()
  isPool!: boolean;
}

/**
 * Vòng đời máy (3.10) — CHUYỂN từ AssetsAdminController sang TicketsModule để orchestrator
 * (Tickets→Assets) cascade hủy booking trong CÙNG tx, KHÔNG cạnh ngược Assets→Tickets (AD-1).
 * Path `/admin/assets/:id/...` GIỮ NGUYÊN — FE không đổi.
 */
@Controller('admin/assets')
@Roles('sa', 'admin')
export class AssetLifecycleController {
  constructor(private readonly tickets: TicketsService) {}

  @Post(':id/lock')
  @HttpCode(200)
  lock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: LockAssetDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tickets.lockAssetCascade(
      id,
      body.reason,
      body.eta ?? null,
      body.version,
      requireSub(req),
    );
  }

  @Post(':id/unlock')
  @HttpCode(200)
  unlock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VersionDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tickets.unlockAsset(id, body.version, requireSub(req));
  }

  @Post(':id/dispose')
  @HttpCode(200)
  dispose(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VersionDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tickets.disposeAssetCascade(id, body.version, requireSub(req));
  }

  @Put(':id/pool')
  setPool(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetPoolDto,
    @Req() req: AuthedRequest,
  ) {
    return this.tickets.setPoolCascade(
      id,
      body.isPool,
      body.version,
      requireSub(req),
    );
  }
}

function requireSub(req: AuthedRequest): string {
  if (!req.user) {
    throw new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: 'Chưa đăng nhập.',
    });
  }
  return req.user.sub;
}
