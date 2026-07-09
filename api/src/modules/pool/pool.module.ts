import { Module } from '@nestjs/common';
import { TicketsModule } from '../tickets/tickets.module';
import { PoolController } from './pool.controller';
import { PoolService } from './pool.service';

// TicketsModule export TicketsService (sở hữu is_pool + cascade). Pool → Tickets một chiều (AD-1).
@Module({
  imports: [TicketsModule],
  controllers: [PoolController],
  providers: [PoolService],
})
export class PoolModule {}
