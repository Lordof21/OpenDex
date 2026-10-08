// Görsel doğrulama harness'ı için Vite yapılandırması (run.sh bunu frontend/ altına geçici kopyalar).
// Üretim obfuscator eklentisi YOK; dev sunucusu node_modules dışındaki yazı tiplerini de servis edebilsin diye fs.strict kapalı.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  define: { __OPENDEX_DEV_TOKEN__: 'undefined' },
  resolve: { alias: { '@': path.resolve(__dirname, './src'), 'motion/react': 'framer-motion' } },
  server: { fs: { strict: false } },
});
