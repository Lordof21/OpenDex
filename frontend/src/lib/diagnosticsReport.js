import { api } from './api.js';
import { logger } from './logger.js';
import { t } from '../i18n/index.js';

async function safeGet(path) {
  try {
    return await api.get(path);
  } catch (err) {
    return { __error: String(err?.message || err) };
  }
}

const block = (title, lines) => [`\n## ${title}`, ...lines];

/**
 * Sorun anında TEK panoya kopyalanacak rapor: tarayıcı halka tamponu + backend log dosyasının sonu +
 * yayın sağlığı sayaçları + telefon ekran durumu. İstek başarısızsa o bölüm hata metniyle doldurulur
 * (rapor asla tümden başarısız olmaz).
 */
export async function buildDiagnosticsReport({ backendLines = 300, browserLines = 500 } = {}) {
  const [tail, streams, power, level] = await Promise.all([
    safeGet(`/api/diagnostics/log-tail?lines=${backendLines}`),
    safeGet('/api/diagnostics/streams'),
    safeGet('/api/device/display-power'),
    safeGet('/api/diagnostics/log-level'),
  ]);

  const out = [t('lib.opendex_tanilama_raporu_toisostring', { toISOString: new Date().toISOString() })];
  out.push(t('lib.tarayici_value', { value: typeof navigator !== 'undefined' ? navigator.userAgent : '?' }));
  out.push(t('lib.tarayici_izleme_value', { value: logger.getTrace().join(',') || t('common.kapali') }));
  out.push(`Backend izleme: ${level?.trace?.join(',') || (level?.__error ? t('lib.okunamadi_error', { __error: level.__error }) : t('common.kapali'))}`);
  out.push(t('lib.backend_log_dosyasi_value', { value: level?.log_file || '?' }));

  out.push(...block(t('lib.telefon_ekrani_gercek_durum'), [JSON.stringify(power)]));
  out.push(...block(t('lib.yayin_sagligi_resync_skip_ahead'), [JSON.stringify(streams)]));
  out.push(
    ...block(
      `Backend logu (son ${backendLines})`,
      tail?.__error ? [t('lib.alinamadi_error', { __error: tail.__error })] : tail?.lines?.length ? tail.lines : [t('lib.bos')],
    ),
  );
  const browser = logger.dump(browserLines);
  out.push(...block(t('lib.tarayici_logu_son_browserlines', { browserLines }), browser.length ? browser : [t('lib.bos')]));
  return out.join('\n');
}

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* izin yok → yedek yol */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function copyDiagnosticsReport(options) {
  const text = await buildDiagnosticsReport(options);
  const ok = await copyText(text);
  return { ok, text, lines: text.split('\n').length };
}
