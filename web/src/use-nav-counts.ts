import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './api-client';

/**
 * Số đếm cho badge sidebar (app-shell): Tài sản (tổng máy), Phần mềm (số license),
 * Duyệt (yêu cầu mượn chờ xử lý). Chỉ chạy cho admin/sa. refetch nhẹ, không chặn UI.
 */
export function useNavCounts(enabled: boolean) {
  const assets = useQuery({
    queryKey: ['nav-count', 'assets'],
    queryFn: () =>
      apiFetch<{ total: number }>(
        '/api/admin/assets?excludeSoftware=true&pageSize=1',
      ).then((r) => r.total),
    enabled,
    staleTime: 60_000,
  });
  const software = useQuery({
    queryKey: ['nav-count', 'software'],
    queryFn: () =>
      apiFetch<unknown[]>('/api/admin/assets/software-groups').then(
        (r) => r.length,
      ),
    enabled,
    staleTime: 60_000,
  });
  const approvals = useQuery({
    queryKey: ['nav-count', 'approvals'],
    queryFn: () =>
      apiFetch<unknown[]>('/api/admin/tickets/pending-approval').then(
        (r) => r.length,
      ),
    enabled,
    staleTime: 30_000,
  });
  // Map theo key nav để sidebar gắn badge đúng mục.
  return {
    'nav.assets': assets.data,
    'nav.software': software.data,
    'nav.lending': approvals.data,
  } as Record<string, number | undefined>;
}
