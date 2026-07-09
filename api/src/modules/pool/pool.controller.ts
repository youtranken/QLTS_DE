import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsString, MaxLength } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import type { AuthedRequest } from '../auth/identity.guard';
import { PoolService } from './pool.service';

class AddPoolDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  code!: string;
}

/** Pool máy cho mượn (8.3) — Admin/SA. Gỡ khỏi pool dùng PUT /admin/assets/:id/pool sẵn có. */
@Controller('admin/pool')
@Roles('admin', 'sa')
export class PoolController {
  constructor(private readonly pool: PoolService) {}

  @Get()
  list() {
    return this.pool.list();
  }

  @Post()
  add(@Body() body: AddPoolDto, @Req() req: AuthedRequest) {
    return this.pool.addByCode(body.code, requireSub(req));
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
