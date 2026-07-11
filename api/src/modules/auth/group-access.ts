/**
 * Gate access theo group (story 10.2): user được vào QLTS nếu group của họ (claim SSO)
 * giao với danh sách group PMH ID gán cho client QLTS. So khớp KHÔNG phân biệt hoa/thường
 * (tránh lệch cấu hình khoá nhầm). Đây là gate ACCESS — KHÔNG suy ra ROLE (AD-8).
 */
export function intersectsCI(
  userGroups: string[] | undefined,
  allowed: string[],
): boolean {
  if (!userGroups || userGroups.length === 0 || allowed.length === 0) {
    return false;
  }
  const allowedLower = new Set(allowed.map((g) => g.toLowerCase()));
  return userGroups.some(
    (g) => typeof g === 'string' && allowedLower.has(g.toLowerCase()),
  );
}
