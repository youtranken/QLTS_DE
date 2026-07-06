import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'qlts:is_public';

/** Route không yêu cầu đăng nhập (health, login, callback, webhook...). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
