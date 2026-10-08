import { api } from './api.js';
import { logger } from './logger.js';

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

  const out = [`# OpenDeX tanılama raporu — ${new Date().toISOString()}`];
  out.push(`Tarayıcı: ${typeof navigator !== 'undefined' ? navigator.userAgent : '?'}`);
  out.push(`Tarayıcı izleme: ${logger.getTrace().join(',') || 'kapalı'}`);
  out.push(`Backend izleme: ${level?.trace?.join(',') || (level?.__error ? `okunamadı (${level.__error})` : 'kapalı')}`);
  out.push(`Backend log dosyası: ${level?.log_file || '?'}`);

  out.push(...block('Telefon ekranı (gerçek durum)', [JSON.stringify(power)]));
  out.push(...block('Yayın sağlığı (resync/skip_ahead sayaçları)', [JSON.stringify(streams)]));
  out.push(
    ...block(
      `Backend logu (son ${backendLines})`,
      tail?.__error ? [`(alınamadı: ${tail.__error})`] : tail?.lines?.length ? tail.lines : ['(boş)'],
    ),
  );
  const browser = logger.dump(browserLines);
  out.push(...block(`Tarayıcı logu (son ${browserLines})`, browser.length ? browser : ['(boş)']));
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
