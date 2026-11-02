import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } }
  },
  renderer: {
    base: './',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': shared,
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      // electron-vite 默认不压缩渲染层产物（首屏 JS 1.6MB）；压缩后体积约减半，解析更快（decisions）
      minify: 'esbuild',
      // 500KB 的默认告警针对网页下载；这里从本地磁盘读。主包 ≈ xterm 322K + 图标 228K + react-dom 178K，
      // 体积上限改由 scripts/verify-perf.cjs 的预算把关（首屏 JS ≤ 900KB）
      chunkSizeWarningLimit: 1024,
      // 小于 4KB 的图标默认内联成 base64（agent 图标 + pi.png ≈ 10KB 首屏 JS）；改成文件由 <img> 异步取，不占解析
      assetsInlineLimit: 0,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
        output: { manualChunks: undefined }
      }
    }
  }
})
