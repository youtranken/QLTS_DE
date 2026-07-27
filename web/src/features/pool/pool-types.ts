/** Kiểu dùng chung cho Pool máy — tách khỏi pool-page.tsx để pool-table.tsx
 *  không phải import ngược lại trang (phá cycle pool-page ↔ pool-table). */
export interface PoolItem {
  id: string;
  code: string;
  type: string;
  configuration: string | null;
  brand: string | null;
  status: string;
  version: number;
  assignedUserName: string | null;
  // B1 (UAT 2026-07-12): phần mềm đang cài trên máy (comma-joined).
  installedSoftware: string | null;
  // Người đang mượn (booking delivered / ticket in_use). null = máy sẵn sàng.
  currentBorrowerName: string | null;
}
