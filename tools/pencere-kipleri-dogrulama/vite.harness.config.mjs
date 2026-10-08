// Pencere kipleri harness'ı için Vite yapılandırması (run.sh bunu frontend/ altına geçici kopyalar).
// VideoCanvas yerine sahte bir tuval gelir (WebCodecs / WebSocket gerekmez); gerçek WindowFrame, TitleBar, HubPanel ve Taskbar kullanılır.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  define: { __OPENDEX_DEV_TOKEN__: 'undefined' },
  resolve: {
    alias: [
      { find: /^\.\/VideoCanvas\.jsx$/, replacement: path.resolve(__dirname, './harness-video-canvas.jsx') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: 'motion/react', replacement: 'framer-motion' },
    ],
  },
  server: { fs: { strict: false } },
});
