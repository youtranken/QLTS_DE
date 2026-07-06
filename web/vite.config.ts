import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Dev ngoài Docker: giữ same-origin /api như nginx làm ở production
    // (bắt buộc cho cookie httpOnly SameSite=Strict — story 1.2)
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
