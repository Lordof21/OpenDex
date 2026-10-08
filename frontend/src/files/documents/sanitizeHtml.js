// Bir belgeden (DOCX) çıkan HTML'i güvenli alt kümeye indirir. Belge GÜVENİLMEYEN girdidir: betik, olay işleyicisi, stil,
// iframe/svg, javascript: bağlantısı ve harici kaynak yüklemesi yoktur. İkinci kat savunma: sonuç ayrıca betiksiz bir
// sandbox iframe'de (srcdoc + CSP) gösterilir (DocumentBodies).

const ALLOWED = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col', 'a', 'img', 'blockquote', 'pre', 'code',
  'span', 'div',
]);
// Çocuklarıyla birlikte atılanlar (içeriği metin olarak bile gösterilmemeli).
const DROPPED = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'form', 'input', 'button', 'textarea',
  'select', 'link', 'meta', 'base', 'video', 'audio', 'source', 'canvas', 'frame', 'frameset', 'applet', 'head', 'title',
]);
const ATTRS = { a: ['href', 'title'], img: ['src', 'alt', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], col: ['span'] };

const SAFE_HREF = /^(https?:|mailto:|#)/i;
const SAFE_IMG = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=]+$/i;
// Tarayıcının URL ayrıştırmasının yok saydığı karakterler ("java\nscript:") güvenlik denetimini atlatmasın.
const squash = (value) => value.replace(/[\u0000- \u007f-\u009f]/g, '');

function clean(node) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) continue;                                   // metin
    if (child.nodeType !== 1) { child.remove(); continue; }               // yorum, işlem yönergesi…
    const tag = child.localName;
    if (DROPPED.has(tag)) { child.remove(); continue; }
    clean(child);
    if (!ALLOWED.has(tag)) { child.replaceWith(...Array.from(child.childNodes)); continue; }   // etiketi at, içeriği tut
    const keep = ATTRS[tag] || [];
    for (const attr of Array.from(child.attributes)) {
      if (!keep.includes(attr.name)) child.removeAttribute(attr.name);
    }
    if (tag === 'a') {
      const href = squash(child.getAttribute('href') || '');
      if (SAFE_HREF.test(href)) { child.setAttribute('rel', 'noopener noreferrer nofollow'); } else { child.removeAttribute('href'); }
    } else if (tag === 'img' && !SAFE_IMG.test(squash(child.getAttribute('src') || ''))) {
      child.remove();                                                     // yalnız belgenin içine gömülü resimler
    }
  }
}

/** HTML dizgesi → güvenli HTML dizgesi. */
export function sanitizeDocumentHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');   // etkisiz belge: betik çalışmaz, resim yüklenmez
  clean(doc.body);
  return doc.body.innerHTML;
}
