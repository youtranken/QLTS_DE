import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { BookingModule } from '../booking/booking.module';
import { TicketsModule } from '../tickets/tickets.module';
import { ChatHistoryService } from './chat-history.service';
import { ChatbotController } from './chatbot.controller';
import { ChatbotGuidedService } from './chatbot-guided.service';
import { ChatbotService } from './chatbot.service';
import { ChatbotToolsService } from './chatbot-tools.service';
import { GeminiAdapter } from './gemini.adapter';

/**
 * Epic 12 — chatbot v1 (chỉ đọc). Bọc AssetsService/BookingService qua lớp tool;
 * DRIZZLE_DB từ DatabaseModule (@Global). Không phá ranh giới module (AD-1).
 */
@Module({
  imports: [AssetsModule, BookingModule, TicketsModule],
  controllers: [ChatbotController],
  providers: [
    ChatbotService,
    ChatbotToolsService,
    ChatbotGuidedService,
    GeminiAdapter,
    ChatHistoryService,
  ],
})
export class ChatbotModule {}
