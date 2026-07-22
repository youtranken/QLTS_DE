import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { AuthedRequest } from '../auth/identity.guard';
import { Roles } from '../auth/roles.decorator';
import { ChatHistoryService } from './chat-history.service';
import { ChatbotService } from './chatbot.service';
import type { Identity } from './chatbot.types';

class ActionDto {
  @IsString()
  @MaxLength(40)
  intent!: string;

  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

class ChatMessageDto {
  /** Cuộc đang mở (tùy chọn) — thiếu = tạo cuộc mới. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  /** Câu gõ tự do (→ Gemini/fallback). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  /** Hoặc thao tác nút bấm (guided). */
  @IsOptional()
  @ValidateNested()
  @Type(() => ActionDto)
  action?: ActionDto;
}

/**
 * Chatbot v1 (Epic 12) — mọi vai đăng nhập. Self-scoped theo req.user.sub.
 * Guards toàn cục (Identity/Csrf/Roles) đã bảo vệ; POST/DELETE cần X-CSRF-Token (FE).
 */
@Controller('chatbot')
@Roles('member', 'admin', 'sa')
export class ChatbotController {
  constructor(
    private readonly chatbot: ChatbotService,
    private readonly history: ChatHistoryService,
  ) {}

  /** Siết riêng để chống đốt quota Gemini free-tier (G11) — ngoài UserThrottler toàn cục. */
  @Post('message')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  message(@Body() body: ChatMessageDto, @Req() req: AuthedRequest) {
    return this.chatbot.handle(identity(req), body);
  }

  @Get('conversations')
  listConversations(@Req() req: AuthedRequest) {
    return this.history.listConversations(identity(req).sub);
  }

  @Post('conversations')
  @HttpCode(201)
  newConversation(@Req() req: AuthedRequest) {
    return this.history.newConversation(identity(req).sub);
  }

  @Get('conversations/:id')
  getConversation(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    return this.history.getMessages(identity(req).sub, id);
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  deleteConversation(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest,
  ) {
    return this.history.deleteConversation(identity(req).sub, id);
  }
}

function identity(req: AuthedRequest): Identity {
  if (!req.user) {
    throw new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: 'Chưa đăng nhập.',
    });
  }
  return { sub: req.user.sub, role: req.user.role };
}
