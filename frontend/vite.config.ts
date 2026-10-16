import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // 把体积较大的第三方库拆成独立 chunk:首屏只需主包,
    // 动效库与终端库按需并行加载,不阻塞渲染。
    rollupOptions: {
      output: {
        // Vite 8 使用 Rolldown,手动分包走 codeSplitting
        // (advancedChunks 已废弃,两者结构一致,只是改了名字)
        codeSplitting: {
          groups: [{ name: 'motion', test: /node_modules\/motion/ }],
        },
      },
    },
  },
  server: {
    port: 5173,
    // 开发期把 /api 代理到后端,避免本地 CORS 配置
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
