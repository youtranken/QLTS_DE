import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

export interface ErrorBody {
  statusCode: number;
  code: string;
  message: string;
}

/**
 * Convention toàn hệ: mọi lỗi REST trả { statusCode, code, message }.
 * Story 3.x sẽ mở rộng mapper 409 (SLOT_TAKEN / ASSET_UNAVAILABLE / STALE_VERSION).
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = this.toBody(exception);
    if (body.statusCode >= 500) {
      this.logger.error(
        exception instanceof Error
          ? (exception.stack ?? exception.message)
          : String(exception),
      );
    }
    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const raw = exception.getResponse();
      if (typeof raw === 'string') {
        return { statusCode, code: this.defaultCode(statusCode), message: raw };
      }
      const obj = raw as Record<string, unknown>;
      const message = Array.isArray(obj.message)
        ? (obj.message as string[]).join('; ')
        : typeof obj.message === 'string'
          ? obj.message
          : exception.message;
      const code =
        typeof obj.code === 'string' ? obj.code : this.defaultCode(statusCode);
      return { statusCode, code, message };
    }
    // Lỗi không đoán trước: không lộ chi tiết nội bộ ra body.
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    };
  }

  private defaultCode(statusCode: number): string {
    return HttpStatus[statusCode] ?? `HTTP_${statusCode}`;
  }
}
