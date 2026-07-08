import { Module } from '@nestjs/common';
import { SystemConfigModule } from '../config/config.module';
import { DirectoryClient, DIRECTORY_CLIENT } from './directory.client';
import { DirectorySyncService } from './directory-sync.service';
import { DirectorySyncScheduler } from './directory-sync.scheduler';
import { UsersAdminController } from './users-admin.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [SystemConfigModule],
  controllers: [UsersController, UsersAdminController],
  providers: [
    UsersService,
    DirectorySyncService,
    DirectorySyncScheduler,
    { provide: DIRECTORY_CLIENT, useClass: DirectoryClient },
  ],
  exports: [UsersService],
})
export class UsersModule {}
