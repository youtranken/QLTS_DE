import { Module } from '@nestjs/common';
import { DirectoryClient, DIRECTORY_CLIENT } from './directory.client';
import { DirectorySyncService } from './directory-sync.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [
    UsersService,
    DirectorySyncService,
    { provide: DIRECTORY_CLIENT, useClass: DirectoryClient },
  ],
  exports: [UsersService],
})
export class UsersModule {}
