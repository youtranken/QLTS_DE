import { Injectable, Logger } from '@nestjs/common';

// alias "latest" → luôn trỏ bản Flash MỚI NHẤT (Gemini 3.x-class); tránh lỗi 404
// "no longer available to new users" khi Google ngừng hỗ trợ phiên bản cũ (2.5-flash
// đã dính). Flash đầy đủ (không lite) → hiểu tiếng Việt tốt hơn cho việc chọn tool +
// trích ngày. Muốn mạnh hơn nữa: 'gemini-pro-latest' (quota ngày hẹp hơn, chậm hơn).
const MODEL = 'gemini-flash-latest';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const TIMEOUT_MS = 8000;

export type ToolName =
  | 'search_assets'
  | 'my_assets'
  | 'check_availability'
  | 'get_asset'
  | 'day_availability'
  | 'asset_stats'
  | 'my_borrowings'
  | 'pending_approvals';
const WHITELIST = new Set<ToolName>([
  'search_assets',
  'my_assets',
  'check_availability',
  'get_asset',
  'day_availability',
  'asset_stats',
  'my_borrowings',
  'pending_approvals',
]);

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
  /** Chữ ký "suy nghĩ" Gemini 3.x cấp kèm functionCall — PHẢI echo lại ở chặng compose. */
  thoughtSignature?: string;
}

/** Gemini trả lời hội thoại (chào hỏi/ngoài phạm vi) — KHÔNG gọi tool, không đụng dữ liệu. */
export interface TextReply {
  text: string;
}

export type InterpretResult = ToolCall | TextReply | null;

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
  {
    name: 'asset_stats',
    description:
      'Thống kê tổng hợp: tổng số tài sản, đếm theo loại/trạng thái, tổng giá trị, số sắp hết hạn. Dùng khi hỏi "bao nhiêu", "tổng", "mỗi loại mấy cái", "tổng giá trị".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'my_borrowings',
    description:
      'Các máy người dùng ĐANG MƯỢN (booking/yêu cầu của họ) + hạn trả + trạng thái. Dùng khi hỏi "tôi đang mượn máy nào", "khi nào phải trả", "yêu cầu mượn tới đâu".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'pending_approvals',
    description:
      'CHỈ ADMIN: hàng chờ duyệt mượn + chờ duyệt gia hạn. Dùng khi admin hỏi "có gì chờ duyệt", "bao nhiêu yêu cầu chờ", "chờ gia hạn".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'day_availability',
    description:
      'Xem KHUNG GIỜ còn trống của máy pool trong MỘT ngày cụ thể. Dùng khi hỏi "ngày X giờ nào trống / mấy giờ rảnh".',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        type: { type: 'string', description: 'loại máy (tùy chọn)' },
      },
      required: ['date'],
    },
  },
  {
    name: 'get_asset',
    description:
      'Xem CHI TIẾT một máy theo mã. Dùng khi người dùng hỏi thuộc tính cụ thể của 1 máy.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'mã máy, vd MTS-123' },
        aspects: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'config',
              'price',
              'place',
              'serial',
              'warranty',
              'brand',
              'holder',
              'note',
              'software',
            ],
          },
          description:
            'CHỈ những khía cạnh người dùng HỎI: config=cấu hình, price=giá, place=vị trí, serial, warranty=bảo hành/hạn, brand=hãng, holder=người giữ, note=ghi chú, software=phần mềm',
        },
      },
      required: ['code'],
    },
  },
];

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thoughtSignature?: string;
        functionCall?: { name?: string; args?: Record<string, unknown> };
      }>;
    };
  }>;
}

/**
 * Adapter Gemini free-tier — 2 chặng (hybrid RAG):
 *  - interpret(): câu → chọn tool + args, HOẶC câu trả lời text (chào hỏi/ngoài phạm vi).
 *  - compose(): đưa kết quả tool (role-scoped, đã cắt trần) lại cho Gemini soạn câu trả lời
 *    tự nhiên. Đây là chặng DUY NHẤT dữ liệu tài sản ra Google (user đã đồng ý — có khoá
 *    chống bịa; nút bấm/guided KHÔNG đi qua đây, không lộ dữ liệu).
 * Lỗi/timeout/thiếu key → null (orchestrator lùi về template/fallback).
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
  ): Promise<InterpretResult> {
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
      return extractResult((await res.json()) as GeminiResponse);
    } catch (e) {
      this.logger.warn(`Gemini lỗi/timeout: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * RAG bước 2 — gửi kết quả tool (dữ liệu role-scoped, đã cắt trần) lại cho Gemini để
   * SOẠN câu trả lời tự nhiên (câu bất kỳ/nhiều vế). null nếu lỗi → orchestrator dùng
   * template thay thế. Đây là chặng DUY NHẤT dữ liệu tài sản ra Google (user đã đồng ý).
   */
  async compose(
    userMessage: string,
    functionName: string,
    functionArgs: Record<string, unknown>,
    responseData: unknown,
    ctx: GeminiContext,
    thoughtSignature?: string,
  ): Promise<string | null> {
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
          systemInstruction: { parts: [{ text: composePrompt(ctx) }] },
          // Khai tools (thiếu → functionCall trong history bị 400) NHƯNG ép mode NONE để
          // model SOẠN TEXT thay vì gọi hàm tiếp.
          tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
          toolConfig: { functionCallingConfig: { mode: 'NONE' } },
          contents: [
            { role: 'user', parts: [{ text: userMessage }] },
            {
              role: 'model',
              parts: [
                {
                  functionCall: { name: functionName, args: functionArgs },
                  ...(thoughtSignature ? { thoughtSignature } : {}),
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: functionName,
                    response: { data: responseData },
                  },
                },
              ],
            },
          ],
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Gemini compose HTTP ${res.status}`);
        return null;
      }
      const data = (await res.json()) as GeminiResponse;
      const parts = data.candidates?.[0]?.content?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (typeof p.text === 'string' && p.text.trim()) return p.text.trim();
        }
      }
      return null;
    } catch (e) {
      this.logger.warn(`Gemini compose lỗi: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function composePrompt(ctx: GeminiContext): string {
  return [
    'Bạn là trợ lý QLTS (quản lý tài sản nội bộ).',
    `Hôm nay ${ctx.today} (+07:00). Người dùng vai '${ctx.role}'.`,
    'Dựa CHỈ trên dữ liệu trong functionResponse để trả lời câu hỏi, NGẮN GỌN, tự nhiên, tiếng Việt.',
    'Trả lời TRỌNG TÂM đúng câu hỏi (kể cả nhiều vế): so sánh/cái nào nhất/tóm tắt. Người dùng đã thấy bảng chi tiết bên dưới nên KHÔNG liệt kê lại toàn bộ.',
    'TUYỆT ĐỐI không bịa: nếu dữ liệu được cấp không chứa thông tin được hỏi, nói "mình không có thông tin đó". Chỉ kết luận trong phạm vi dữ liệu được cấp.',
  ].join(' ');
}

function systemPrompt(ctx: GeminiContext): string {
  return [
    'Bạn là trợ lý QLTS (quản lý tài sản nội bộ).',
    `Hôm nay là ${ctx.today} (múi giờ +07:00, Việt Nam). Người dùng có vai '${ctx.role}'.`,
    'Khi người dùng HỎI VỀ tài sản/máy (danh sách, chi tiết 1 máy, máy đang giữ, máy còn trống) → gọi đúng MỘT hàm phù hợp và điền tham số.',
    'Hỏi GIỜ/khung giờ trống của một NGÀY cụ thể ("ngày 26 giờ nào trống") → day_availability(date). Còn hỏi máy trống trong 1 khoảng giờ cho sẵn → check_availability.',
    'Hỏi THỐNG KÊ (bao nhiêu/tổng/mỗi loại mấy cái/tổng giá trị) → asset_stats. Hỏi "tôi đang mượn gì/khi nào trả" → my_borrowings. Admin hỏi "có gì chờ duyệt/gia hạn" → pending_approvals.',
    'Hỏi CHI TIẾT/thuộc tính của MỘT máy cụ thể (theo mã) → dùng get_asset, điền aspects ĐÚNG thứ được hỏi (chỉ hỏi cấu hình thì aspects=["config"]; hỏi giá thì ["price"]…), KHÔNG thêm khía cạnh không được hỏi.',
    'Khoảng ngày dùng YYYY-MM-DD; thời điểm mượn dùng ISO-8601 có offset +07:00.',
    'Nếu là CHÀO HỎI / nói chuyện phiếm / câu KHÔNG liên quan tài sản → KHÔNG gọi hàm; trả lời NGẮN GỌN, thân thiện bằng tiếng Việt và gợi ý có thể hỏi về danh sách tài sản, máy đang giữ, hoặc máy còn trống. TUYỆT ĐỐI không bịa số liệu/thông tin tài sản khi chưa gọi hàm.',
  ].join(' ');
}

function extractResult(data: GeminiResponse): InterpretResult {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  // Ưu tiên functionCall (hỏi tài sản); nếu không có → dùng text (chào hỏi/ngoài phạm vi).
  for (const part of parts) {
    const fc = part.functionCall;
    if (fc?.name && WHITELIST.has(fc.name as ToolName)) {
      return {
        tool: fc.name as ToolName,
        args: fc.args ?? {},
        thoughtSignature: part.thoughtSignature,
      };
    }
  }
  for (const part of parts) {
    if (typeof part.text === 'string' && part.text.trim()) {
      return { text: part.text.trim() };
    }
  }
  return null;
}
