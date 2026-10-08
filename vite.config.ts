import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './',
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // the original multi-hundred-MB sheets in figther-*/ and materials/ are
  // sources for tools/slice_sprites.py only and must never be bundled
  server: {
    fs: { deny: ['figther-*/**', 'materials/**'] },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
