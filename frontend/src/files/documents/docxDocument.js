// DOCX → salt-okunur, güvenli bir HTML belgesi (srcdoc). Dönüştürme tarayıcıda, bellekte: dosya hiçbir yere yazılmaz.
// mammoth anlamsal HTML üretir (başlık, liste, tablo, gömülü resimler data: olarak); biçim sadakati bilerek sınırlıdır —
// "göz atma" önizlemesi, düzenleyici değil. Çıktı sanitizeDocumentHtml'den geçer ve betiksiz sandbox iframe'e konur.
import { sanitizeDocumentHtml } from './sanitizeHtml.js';

// Belgenin kendi CSP'si: hiçbir ağ isteği, hiçbir betik. (Üst belgenin CSP'sine ek, ikinci kat.)
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
const STYLE = `
  body{margin:0;padding:28px 36px 40px;background:#fff;color:#1f2328;font:15px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}
  h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.4em 0 .5em} h1{font-size:1.7em} h2{font-size:1.4em} h3{font-size:1.2em}
  p{margin:.6em 0} img{max-width:100%;height:auto} a{color:#0969da;text-decoration:underline}
  table{border-collapse:collapse;margin:.8em 0;max-width:100%} td,th{border:1px solid #d0d7de;padding:4px 9px;vertical-align:top}
  blockquote{margin:.8em 0;padding-left:1em;border-left:3px solid #d0d7de;color:#57606a} pre,code{font-family:ui-monospace,Consolas,monospace}
`;

export function wrapDocument(safeBody) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${STYLE}</style></head><body>${safeBody}</body></html>`;
}

/** ArrayBuffer (.docx) → { srcdoc, empty }. Bozuk/şifreli dosyada mammoth'un hatası yükselir. */
export async function docxToDocument(buffer) {
  const mod = await import('mammoth/mammoth.browser.min.js');
  const mammoth = mod.default ?? mod;
  const { value } = await mammoth.convertToHtml({ arrayBuffer: buffer });
  const safe = sanitizeDocumentHtml(value);
  return { srcdoc: wrapDocument(safe), empty: safe.replace(/<[^>]*>/g, '').trim() === '' && !safe.includes('<img') };
}
