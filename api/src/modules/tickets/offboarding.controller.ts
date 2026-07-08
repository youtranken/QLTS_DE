import { Controller, Get } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { OffboardingService } from './offboarding.service';

/** Hàng đợi "cảnh báo nghỉ việc" + "cần đối chiếu" (5.5) — CHỈ Admin/SA. */
@Controller('admin/offboarding')
@Roles('admin', 'sa')
export class OffboardingController {
  constructor(private readonly offboarding: OffboardingService) {}

  @Get()
  list() {
    return this.offboarding.listOffboardingQueue();
  }
}
