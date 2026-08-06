import { defineConfig } from 'vitest/config'
import viteReact from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: fileURLToPath(new URL('./node_modules/buffer/index.js', import.meta.url)),
      'cloudflare:workers': fileURLToPath(new URL('./src/lib/__tests__/__mocks__/cloudflare-workers.ts', import.meta.url)),
    },
    tsconfigPaths: true,
    preserveSymlinks: false,
    dedupe: ['@stellar/stellar-sdk', '@stellar/stellar-base'],
  },
  plugins: [
    viteReact(),
  ],
  test: {
    environment: 'jsdom',
  },
})
