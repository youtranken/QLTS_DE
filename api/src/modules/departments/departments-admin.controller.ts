import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Roles } from '../auth/roles.decorator';
import type { AuthedRequest } from '../auth/identity.guard';
import { DepartmentsService } from './departments.service';

class ListQueryDto {
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
  pageSize = 50;
}

class CreateDepartmentDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

class UpdateDepartmentDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** Quản lý danh mục Phòng ban (7.1) — Admin/SA. */
@Controller('admin/departments')
@Roles('admin', 'sa')
export class DepartmentsAdminController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  list(@Query() query: ListQueryDto) {
    return this.departments.listAll(query.page, query.pageSize);
  }

  // Audit ghi trong service (object_id đúng + detail giàu) — KHÔNG dùng @Audited
  // để tránh ghi đúp qua AuditInterceptor toàn cục (review 7.1 BLOCKER).
  @Post()
  create(@Body() body: CreateDepartmentDto, @Req() req: AuthedRequest) {
    return this.departments.create(body.name, requireSub(req));
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() body: UpdateDepartmentDto,
    @Req() req: AuthedRequest,
  ) {
    if (body.name === undefined && body.active === undefined) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: 'Phải có ít nhất một field (name/active).',
      });
    }
    return this.departments.update(
      id,
      { name: body.name, active: body.active },
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
