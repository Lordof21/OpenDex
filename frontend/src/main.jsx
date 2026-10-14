import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './state/ThemeContext.jsx';
import { installLogTransport } from './lib/logTransport.js';
import { initLanguage } from './i18n/index.js';
import './index.css';

installLogTransport();

// Uygulama, dil yüklendikten SONRA içe aktarılır: modül düzeyindeki `t()` çağrıları da doğru dili görür (i18n/index.js).
initLanguage()
  .catch(() => {}) // dil dosyası okunamazsa Türkçe ile açılır
  .then(() => import('./App.jsx'))
  .then(({ default: App }) => {
    createRoot(document.getElementById('root')).render(
      <React.StrictMode>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </React.StrictMode>,
    );
  });
