import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      buffer: fileURLToPath(new URL('./node_modules/buffer/index.js', import.meta.url)),
    },
    preserveSymlinks: false,
    dedupe: ['@stellar/stellar-sdk', '@stellar/stellar-base'],
  },
  optimizeDeps: {
    include: [
      'buffer',
      '@stellar/stellar-sdk',
      '@stellar/stellar-sdk/rpc',
      '@stellar/stellar-sdk/contract',
      '@openzeppelin/relayer-plugin-channels',
    ],
  },
  ssr: {
    optimizeDeps: {
      include: ['@openzeppelin/relayer-plugin-channels'],
    },
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/, /multisig-account/],
      transformMixedEsModules: true,
    },
  },
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
