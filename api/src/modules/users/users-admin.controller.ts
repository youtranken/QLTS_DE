import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '../auth/roles.decorator';
import type { AuthedRequest } from '../auth/identity.guard';
import { UsersService } from './users.service';

class ListUsersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

class UpdateRoleDto {
  /** CHỈ admin|member — 'sa' không bao giờ qua API (SA chỉ từ env, AC 2). */
  @IsIn(['admin', 'member'])
  role!: 'admin' | 'member';
}

class UpdatePermissionsDto {
  @IsOptional()
  @IsBoolean()
  canLongTerm?: boolean;

  @IsOptional()
  @IsBoolean()
  canRecurring?: boolean;
}

@Controller('admin/users')
export class UsersAdminController {
  constructor(private readonly users: UsersService) {}

  /** Màn Vai trò (1.5) + màn gán quyền (1.6): SA và Admin xem được danh sách. */
  @Get()
  @Roles('sa', 'admin')
  list(@Query() query: ListUsersQueryDto) {
    return this.users.list({
      search: query.search,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  /** Bổ nhiệm/miễn nhiệm Admin — CHỈ SSA (quyền cấp phát vai là độc quyền bậc SSA, 10.1).
   *  Admin KHÔNG tự tạo admin ngang hàng → giữ tôn ti SSA > admin. Audit from→to trong service. */
  @Put(':sub/role')
  @Roles('sa')
  async updateRole(
    @Param('sub') sub: string,
    @Body() body: UpdateRoleDto,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: boolean }> {
    if (!req.user) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Chưa đăng nhập.',
      });
    }
    await this.users.updateRole(sub, body.role, req.user.sub);
    return { ok: true };
  }

  /** Gán/thu hồi 2 quyền per-user (1.6) — SA và Admin (class @Roles bị override). */
  @Put(':sub/permissions')
  @Roles('sa', 'admin')
  async updatePermissions(
    @Param('sub') sub: string,
    @Body() body: UpdatePermissionsDto,
    @Req() req: AuthedRequest,
  ): Promise<{ ok: boolean }> {
    if (!req.user) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Chưa đăng nhập.',
      });
    }
    // == null bắt cả null lẫn undefined (IsOptional bỏ qua validate cho null)
    if (body.canLongTerm == null && body.canRecurring == null) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'Phải có ít nhất một cờ quyền (canLongTerm/canRecurring).',
      });
    }
    await this.users.updatePermissions(
      sub,
      { canLongTerm: body.canLongTerm, canRecurring: body.canRecurring },
      req.user.sub,
    );
    return { ok: true };
  }
}
