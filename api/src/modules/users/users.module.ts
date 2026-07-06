import { Module } from '@nestjs/common';
import { DirectoryClient, DIRECTORY_CLIENT } from './directory.client';
import { DirectorySyncService } from './directory-sync.service';
import { UsersAdminController } from './users-admin.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController, UsersAdminController],
  providers: [
    UsersService,
    DirectorySyncService,
    { provide: DIRECTORY_CLIENT, useClass: DirectoryClient },
  ],
  exports: [UsersService],
})
export class UsersModule {}
