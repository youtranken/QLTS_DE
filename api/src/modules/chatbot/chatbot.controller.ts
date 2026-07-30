import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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

  /** Câu gõ tự do (→ tìm tài sản theo từ khoá, nội bộ). */
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

  /** Siết riêng chống spam tra cứu — ngoài UserThrottler toàn cục. */
  @Post('message')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  message(@Body() body: ChatMessageDto, @Req() req: AuthedRequest) {
    // Phải có message HOẶC action — body rỗng {} không tạo lượt "(mở đầu)" thừa.
    if (!body.message?.trim() && !body.action) {
      throw new BadRequestException({
        code: 'EMPTY_CHAT_INPUT',
        message: 'Cần có câu hỏi hoặc thao tác.',
      });
    }
    return this.chatbot.handle(identity(req), body);
  }

  /** Đoạn chat DUY NHẤT của người dùng (mở lại thấy tiếp) — 1 luồng, không đa-cuộc. */
  @Get('history')
  getHistory(@Req() req: AuthedRequest) {
    return this.history.getSingle(identity(req).sub);
  }

  /** "Xoá đoạn chat" — dọn sạch của chính mình. */
  @Delete('history')
  @HttpCode(204)
  clear(@Req() req: AuthedRequest) {
    return this.history.clear(identity(req).sub);
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
