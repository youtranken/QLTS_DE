/** Người dùng đang đăng nhập (session). Tách khỏi panels.tsx: trước đây 37 file
 *  phải import `type { Me }` từ một file UI admin (hub giả, fan-in 38). */
export interface Me {
  sub: string;
  fullName?: string;
  email?: string;
  role: string;
  devMode?: boolean;
  csrfToken: string | null;
  permissions?: { canLongTerm: boolean; canRecurring: boolean };
  // Giờ làm + ngưỡng auto-duyệt từ config SA chỉnh (audit H2/H3) — form Đặt máy đọc thay hardcode.
  workingHours?: { days: number[]; start: string; end: string };
  autoApproveMaxHours?: number;
}
