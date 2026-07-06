/**
 * Escape ký tự đặc biệt của LIKE/ILIKE — search chứa % _ \ không thành wildcard
 * (bài học 1.5; dùng chung users/assets, Epic 3 booking dùng tiếp).
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}
