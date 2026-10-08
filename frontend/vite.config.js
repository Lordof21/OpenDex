import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import os from 'os';
import obfuscator from 'vite-plugin-javascript-obfuscator';

// Dev-time proxy: the SPA talks to the FastAPI backend on :8710 without CORS
// friction; in the Tauri build the same origins apply.
// `npm run dev`: hand the page the backend's per-user API token (backend/app/api/auth.py writes
// ~/.opendex/api-token, 0600) at dev-server start — start the backend first, as docs/DEVELOPMENT.md says.
function devApiToken() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.opendex', 'api-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export default defineConfig(({ command, mode }) => {
  const isProduction = mode === 'production' || command === 'build';
  // The release bundle is obfuscated (see docs/BUILD_AND_RELEASE.md). OPENDEX_NO_OBFUSCATE=1 builds a plain, debuggable bundle —
  // what a contributor, a distro packager or anyone auditing the build wants (the source is public either way).
  const obfuscate = isProduction && !['1', 'true'].includes(String(process.env.OPENDEX_NO_OBFUSCATE || '').toLowerCase());

  return {
    plugins: [
      react(),
      obfuscate && obfuscator({
        apply: 'build',
        options: {
          compact: true,
          controlFlowFlattening: true,
          controlFlowFlatteningThreshold: 0.75,
          deadCodeInjection: true,
          deadCodeInjectionThreshold: 0.3,
          stringArray: true,
          stringArrayEncoding: ['base64', 'rc4'],
          stringArrayThreshold: 0.8,
          // Modül yolları ŞİFRELENMEZ: dinamik `import('@tauri-apps/api/core')` / `import('../files/FilesApp.jsx')` yolu şifrelenince
          // Rollup parçayı hiç üretemiyor ve çalışma anında import() başarısız oluyordu — paketli uygulamada token IPC'si
          // (apiToken.fromTauri) sessizce null dönüp TÜM istekler 401 alıyor, Dosyalar/PDF/Tauri pencere API'leri çalışmıyordu.
          reservedStrings: ['^@tauri-apps/', '^read-excel-file/', '^pdfjs-dist/', '^mammoth/', '^fflate$', '^\\.{1,2}/'],
          splitStrings: true,
          splitStringsChunkLength: 5,
          identifierNamesGenerator: 'hexadecimal',
          renameGlobals: false,
          transformObjectKeys: true,
          unicodeEscapeSequence: false,
          // The Tauri "devtools" Cargo feature is on (src-tauri/Cargo.toml), so the inspector works in the shipped app. The
          // options that fight an inspector are therefore left OFF: debugProtection (near-continuous `debugger;` breaks),
          // selfDefending (breaks the bundle once it is pretty-printed) and disableConsoleOutput (silences the console).
          debugProtection: false,
          selfDefending: false,
          disableConsoleOutput: false,
          numbersToExpressions: true,
          simplify: true,
        },
      }),
    ].filter(Boolean),
    define: {
      __OPENDEX_DEV_TOKEN__:
        command === 'serve' && mode !== 'test' && devApiToken() ? JSON.stringify(devApiToken()) : 'undefined',
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        'motion/react': 'framer-motion',
      },
    },
    build: {
      sourcemap: false,
      minify: 'esbuild',
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'framer-motion', 'zustand', 'lucide-react'],
          },
        },
      },
    },
    server: {
      // Loopback only and no CORS: with the default (`cors: true`, all interfaces) any web page — or any machine on the
      // LAN — could read dev-server responses, and the dev bundle carries the API token define above.
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      cors: false,
      open: false,
      proxy: {
        '/api': { target: 'http://127.0.0.1:8710', changeOrigin: true },
        '/ws': { target: 'ws://127.0.0.1:8710', ws: true },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './tests/setup.js',
    },
  };
});
