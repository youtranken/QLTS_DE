import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'qlts:roles';

export type AppRole = 'member' | 'admin' | 'sa';

/** Route yêu cầu vai cụ thể — enforce bởi RolesGuard (story 1.3, màn bổ nhiệm 1.5). */
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
