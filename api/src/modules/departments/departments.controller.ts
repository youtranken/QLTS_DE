import { Controller, Get } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { DepartmentsService } from './departments.service';

/** Dropdown đặt máy (7.1 AC3) — mọi vai đã đăng nhập, chỉ phòng ban active. */
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @Roles('member', 'admin', 'sa')
  listActive() {
    return this.departments.listActive();
  }
}
