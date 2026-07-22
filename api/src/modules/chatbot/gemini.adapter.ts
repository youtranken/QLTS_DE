import { Injectable, Logger } from '@nestjs/common';

// alias "latest" → luôn trỏ bản Flash MỚI NHẤT (Gemini 3.x-class); tránh lỗi 404
// "no longer available to new users" khi Google ngừng hỗ trợ phiên bản cũ (2.5-flash
// đã dính). Flash đầy đủ (không lite) → hiểu tiếng Việt tốt hơn cho việc chọn tool +
// trích ngày. Muốn mạnh hơn nữa: 'gemini-pro-latest' (quota ngày hẹp hơn, chậm hơn).
const MODEL = 'gemini-flash-latest';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const TIMEOUT_MS = 8000;

export type ToolName = 'search_assets' | 'my_assets' | 'check_availability';
const WHITELIST = new Set<ToolName>([
  'search_assets',
  'my_assets',
  'check_availability',
]);

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

interface GeminiContext {
  today: string;
  role: string;
}

/** Chỉ khai tool ĐỌC (v1) — prompt-injection vô hại vì không có tool ghi. */
const FUNCTION_DECLARATIONS = [
  {
    name: 'search_assets',
    description:
      'Tra cứu danh sách tài sản/máy. Lọc theo loại, trạng thái, khoảng ngày hết hạn, hoặc từ khoá.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'loại tài sản, vd Laptop, PC' },
        status: {
          type: 'string',
          enum: ['in_use', 'locked_repair', 'disposed'],
        },
        endFrom: { type: 'string', description: 'YYYY-MM-DD' },
        endTo: { type: 'string', description: 'YYYY-MM-DD' },
        search: { type: 'string', description: 'từ khoá mã máy/tên người' },
      },
    },
  },
  {
    name: 'my_assets',
    description: 'Liệt kê các tài sản mà chính người dùng đang giữ.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'check_availability',
    description: 'Tìm máy pool còn trống trong một khoảng thời gian.',
    parameters: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'ISO-8601 có offset, vd 2026-07-25T09:00:00+07:00',
        },
        to: { type: 'string', description: 'ISO-8601 có offset' },
        type: { type: 'string', description: 'loại máy (tùy chọn)' },
      },
      required: ['from', 'to'],
    },
  },
];

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        functionCall?: { name?: string; args?: Record<string, unknown> };
      }>;
    };
  }>;
}

/**
 * Adapter Gemini free-tier: dịch câu → chọn tool + args. MỘT-CHẶNG — KHÔNG gửi kết quả
 * tool trở lại Gemini (privacy: chỉ câu hỏi ra Google, không phải dữ liệu tài sản).
 * Lỗi/timeout/thiếu key/không functionCall → null (orchestrator tự lùi về fallback).
 */
@Injectable()
export class GeminiAdapter {
  private readonly logger = new Logger(GeminiAdapter.name);

  isEnabled(): boolean {
    return !!process.env.GEMINI_API_KEY;
  }

  async interpret(
    message: string,
    ctx: GeminiContext,
  ): Promise<ToolCall | null> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt(ctx) }] },
          contents: [{ role: 'user', parts: [{ text: message }] }],
          tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Gemini HTTP ${res.status}`);
        return null;
      }
      return extractFunctionCall((await res.json()) as GeminiResponse);
    } catch (e) {
      this.logger.warn(`Gemini lỗi/timeout: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function systemPrompt(ctx: GeminiContext): string {
  return [
    'Bạn là trợ lý QLTS (quản lý tài sản nội bộ).',
    `Hôm nay là ${ctx.today} (múi giờ +07:00, Việt Nam). Người dùng có vai '${ctx.role}'.`,
    'Hãy chọn đúng MỘT hàm phù hợp để tra cứu và điền tham số.',
    'Khoảng ngày dùng YYYY-MM-DD; thời điểm mượn dùng ISO-8601 có offset +07:00.',
    'Nếu câu hỏi ngoài phạm vi tra cứu tài sản/máy trống, chọn search_assets với từ khoá gần nhất.',
  ].join(' ');
}

function extractFunctionCall(data: GeminiResponse): ToolCall | null {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const fc = part.functionCall;
    if (fc?.name && WHITELIST.has(fc.name as ToolName)) {
      return { tool: fc.name as ToolName, args: fc.args ?? {} };
    }
  }
  return null;
}
