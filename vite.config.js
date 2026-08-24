import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  // 关闭自动清空输出目录：避免构建时一次性删除大量文件触发
  // 本机"安全删除"批量确认保护（非交互环境会中断构建）。
  // 如需彻底清理旧产物，请手动删除 dist/ 后再构建。
  build: {
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    host: true,
  },
})
