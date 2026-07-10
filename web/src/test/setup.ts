import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
// Khởi tạo i18n global (vi mặc định) để useTranslation trả chuỗi thật trong test.
import '../i18n';

afterEach(() => {
  cleanup();
});
