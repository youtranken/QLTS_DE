import { Component, type ReactNode } from 'react';

/**
 * Route dùng React.lazy: khi chunk fail tải (hay gặp nhất là index.html cũ sau khi
 * deploy → tên file chunk băm cũ đã 404) thì import reject QUA Suspense. Không có
 * error boundary nào → React gỡ tới gốc → cả app trắng màn, không lối thoát.
 * Boundary này bắt lỗi render dưới Suspense và mời người dùng tải lại (lấy bản mới).
 */
export class ChunkErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
