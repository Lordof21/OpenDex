import { BASE, authHeaders } from './apiToken.js';
import { logger } from './logger.js';

/**
 * Logger'ın backend taşıması: tarayıcı olayları backend dosya loguna yazılır ("butona bastım → istek gitti →
 * şu cevap geldi" tek zaman çizelgesinde). Uygulama açılışında bir kez çağrılır. Gönderim hataları sessizce
 * yutulur (log göndermek asla hata üretmemeli); logger `fetch` reddini kendi içinde yakalar.
 */
export function installLogTransport() {
  logger.setTransport((entries) =>
    fetch(`${BASE}/api/diagnostics/client-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ entries }),
      keepalive: true,
    }),
  );
  logger.installGlobalCapture();
}
