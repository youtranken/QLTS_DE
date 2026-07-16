/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Đổi thư mục asset build 'assets'→'static' để KHÔNG đụng route SPA '/assets'
    // (nếu để 'assets', nginx serve thẳng dist/assets/ → full-load /assets bị 403).
    assetsDir: 'static',
    rollupOptions: {
      output: {
        // Tách vendor thành chunk cache dài hạn — đổi code app không bắt tải lại thư viện.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@tanstack')) return 'data-vendor';
          if (id.includes('i18next')) return 'i18n-vendor';
          if (
            id.includes('react-router') ||
            id.includes('react-dom') ||
            id.includes('/react/') ||
            id.includes('scheduler')
          )
            return 'react-vendor';
        },
      },
    },
  },
  server: {
    // Dev ngoài Docker: giữ same-origin /api như nginx làm ở production
    // (bắt buộc cho cookie httpOnly SameSite=Strict — story 1.2)
    proxy: {
      '/api': { target: 'https://localhost', changeOrigin: true, secure: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: false,
    restoreMocks: true,
    unstubGlobals: true,
  },
})
