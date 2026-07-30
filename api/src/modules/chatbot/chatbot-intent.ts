import { extractAssetCode, parseVnDate } from './chatbot.helpers';

export interface DetectedIntent {
  intent: string;
  params: Record<string, unknown>;
}

const has = (t: string, ...kw: string[]) => kw.some((k) => t.includes(k));

/**
 * Định tuyến câu hỏi tự do → ý định + tham số, KHÔNG dùng LLM (luật từ khoá + bắt ngày/mã máy).
 * Trả về intent khớp tool trong ChatbotGuidedService; null = không khớp → caller lùi về tìm từ khoá.
 * Thứ tự kiểm tra = độ ưu tiên (cụ thể trước, chung sau).
 */
export function detectIntent(
  message: string,
  today: string,
): DetectedIntent | null {
  const t = message.toLowerCase().trim();
  if (!t) return null;
  const code = extractAssetCode(message);
  const date = parseVnDate(t, today);

  // 1) Lịch sử cấp phát MỘT máy (cần mã)
  if (code && has(t, 'lịch sử', 'ai từng', 'ai dùng', 'ai đang giữ', 'cấp phát'))
    return { intent: 'asset_history', params: { code } };

  // 2) Tìm máy trống (kèm mã → lọc đúng máy đó; kèm ngày → đúng ngày)
  if (
    has(
      t,
      'trống',
      'còn trống',
      'còn máy',
      'máy nào rảnh',
      'rảnh',
      'mượn được máy',
      'đặt máy nào',
      'khung giờ',
    )
  )
    return {
      intent: 'day_availability',
      params: { date: date ?? today, ...(code ? { code } : {}) },
    };

  // 3) Chi tiết/cấu hình MỘT máy (có mã + từ khoá chi tiết, hoặc câu gần như chỉ có mã)
  if (
    code &&
    has(
      t,
      'cấu hình',
      'chi tiết',
      'thông tin',
      'cpu',
      'ram',
      'ổ cứng',
      'serial',
      'giá',
      'bảo hành',
      'ai giữ',
      'ở đâu',
      'phần mềm nào',
    )
  )
    return { intent: 'get_asset', params: { code } };
  if (code && t.replace(code.toLowerCase(), '').trim().length <= 3)
    return { intent: 'get_asset', params: { code } };

  // 4) Của tôi — đang mượn / hạn trả / quá hạn / trạng thái yêu cầu
  if (
    has(
      t,
      'tôi mượn',
      'đang mượn',
      'lượt mượn',
      'mượn của tôi',
      'tôi mượn gì',
      'hạn trả',
      'khi nào trả',
      'trả lúc nào',
      'phải trả',
      'trả máy',
      'bao giờ trả',
      'quá hạn',
      'duyệt chưa',
      'đã duyệt',
      'trạng thái yêu cầu',
      'yêu cầu của tôi',
    )
  )
    return { intent: 'my_borrowings', params: {} };
  // 5) Của tôi — đang giữ
  if (has(t, 'của tôi', 'tôi giữ', 'tôi đang giữ', 'máy tôi', 'tài sản của tôi'))
    return { intent: 'my_assets', params: {} };

  // 6) Máy đang sửa chữa / hỏng → danh sách lọc trạng thái (dùng lại list_result)
  if (has(t, 'đang sửa', 'sửa chữa', 'máy hỏng', 'bị hỏng', 'đang hỏng'))
    return { intent: 'list_result', params: { status: 'locked_repair' } };

  // 7) Hàng chờ duyệt / gia hạn (admin — tool tự chặn quyền)
  if (has(t, 'chờ duyệt', 'cần duyệt', 'hàng chờ', 'chờ gia hạn', 'duyệt mượn'))
    return { intent: 'pending_approvals', params: {} };
  // 8) Cảnh báo EOL (hết hạn / thanh lý)
  if (has(t, 'hết hạn', 'thanh lý', 'eol', 'sắp hết'))
    return { intent: 'eol_alerts', params: {} };
  // 9) Phần mềm / license (bao gồm hỏi còn bản trống)
  if (has(t, 'phần mềm', 'license', 'bản quyền', 'còn bản', 'còn license'))
    return { intent: 'software_info', params: {} };
  // 10) Thống kê số lượng
  if (has(t, 'bao nhiêu', 'tổng số', 'thống kê', 'số lượng', 'mấy máy', 'có mấy'))
    return { intent: 'asset_stats', params: {} };

  // 11) Chính sách: giờ làm việc / giờ mượn
  if (has(t, 'giờ làm việc', 'mấy giờ', 'từ mấy giờ', 'giờ mượn', 'mở cửa'))
    return { intent: 'policy_hours', params: {} };
  // 12) Chính sách: thời hạn mượn / khi nào cần duyệt / cuối tuần
  if (
    has(
      t,
      'tối đa',
      'bao lâu',
      'mấy ngày',
      'mượn được mấy',
      'tự duyệt',
      'tự động duyệt',
      'cuối tuần',
      'thứ 7',
      'thứ bảy',
      'chủ nhật',
      'ngày nghỉ',
      'quy định mượn',
    )
  )
    return { intent: 'policy_borrow', params: {} };

  // 13) Trợ giúp — chatbot làm được gì
  if (
    has(
      t,
      'làm được gì',
      'giúp được gì',
      'hỏi được gì',
      'hỏi gì',
      'hướng dẫn',
      'bạn là ai',
      'chức năng',
      'có thể làm gì',
      'trợ giúp',
      'bạn giúp',
    )
  )
    return { intent: 'help', params: {} };

  return null;
}
