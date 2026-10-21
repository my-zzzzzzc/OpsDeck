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
    // 显式绑定 IPv4,否则 Node 只监听 IPv6 的 [::1],127.0.0.1 将无法访问
    host: '127.0.0.1',
    port: 5173,
    // 开发期把 /api 代理到后端,避免本地 CORS 配置
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      // 日志流与 Web 终端走 WebSocket;不代理的话浏览器会连到 Vite 自己,
      // 表现为日志面板直接"异常"且拿不到后端返回的原因。
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
      },
    },
  },
})
