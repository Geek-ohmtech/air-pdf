import { defineConfig } from 'vite';

// 웹과 데스크톱(Tauri)이 같은 결과물을 쓴다. 상대 경로로 만들어 어느 위치에 올려도 동작한다.
export default defineConfig({
  base: './',
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  worker: { format: 'es' },
  build: {
    target: ['es2022', 'chrome105', 'safari15'],
    chunkSizeWarningLimit: 1200,
    sourcemap: false,
  },
  optimizeDeps: { exclude: ['@embedpdf/pdfium', 'tesseract.js'] },
});
