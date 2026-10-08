// Belge çözücüler: gerçek (küçük) PPTX/DOCX dosyaları bellekte üretilir ve gerçek kütüphanelerle çözülür.
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { sanitizeDocumentHtml } from '../../../src/files/documents/sanitizeHtml.js';
import { docxToDocument } from '../../../src/files/documents/docxDocument.js';
import { readSlides } from '../../../src/files/documents/slides.js';
import { formatCell } from '../../../src/files/documents/workbook.js';
import { columnName } from '../../../src/files/DocumentBodies.jsx';

const zip = (files) => {
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

describe('güvenli HTML', () => {
  it('betik, olay işleyicisi, stil, iframe/svg, javascript: ve harici resim atılır; yapı ve gömülü resim kalır', () => {
    const dirty = '<h1 onclick="x()">Başlık</h1><script>alert(1)</script><p style="x" class="c">Metin <b>kalın</b></p>'
      + '<a href="java\nscript:alert(1)">kötü</a><a href="https://example.com/a">iyi</a>'
      + '<img src="https://evil.test/p.png"><img src="data:image/png;base64,AAAA" onerror="x()" alt="ok">'
      + '<img src="data:image/svg+xml;base64,AAAA"><iframe src="x"></iframe><svg onload="x()"></svg><table><tr><td colspan="2">h</td></tr></table>';
    const clean = sanitizeDocumentHtml(dirty);
    expect(clean).not.toMatch(/script|onclick|onerror|onload|style=|class=|iframe|svg|evil\.test|javascript/i);
    expect(clean).toContain('<h1>Başlık</h1>');
    expect(clean).toContain('<b>kalın</b>');
    expect(clean).toContain('href="https://example.com/a"');
    expect(clean).toContain('src="data:image/png;base64,AAAA"');
    expect(clean).toContain('<td colspan="2">h</td>');
    expect(clean).toMatch(/<a>kötü<\/a>/);                                  // tehlikeli bağlantı metne iner
  });
});

describe('DOCX → belge', () => {
  const docx = (bodyXml) => zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
  });

  it('metin ve kalın yazı çözülür; sonuç betiksiz bir belge olarak (CSP + sandbox için) sarılır', async () => {
    const out = await docxToDocument(docx('<w:p><w:r><w:t>Merhaba </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>dünya</w:t></w:r></w:p>'));
    expect(out.empty).toBe(false);
    expect(out.srcdoc).toContain('Merhaba <strong>dünya</strong>');
    expect(out.srcdoc).toContain("default-src 'none'");
  });

  it('içeriksiz belge "boş" sayılır', async () => {
    expect((await docxToDocument(docx('<w:p/>'))).empty).toBe(true);
  });
});

describe('PPTX → slayt metni', () => {
  const slide = (...texts) => `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${texts.map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`;

  it('slaytlar numara sırasıyla, paragraflar metin olarak; diğer parçalar açılmaz', async () => {
    const slides = await readSlides(zip({
      'ppt/slides/slide10.xml': slide('On'), 'ppt/slides/slide2.xml': slide('İkinci', 'alt satır'), 'ppt/slides/slide1.xml': slide('Birinci', ' '),
      'ppt/media/image1.png': 'not read', 'docProps/core.xml': '<x/>',
    }));
    expect(slides.map((s) => s.number)).toEqual([1, 2, 10]);
    expect(slides[0].paragraphs).toEqual(['Birinci']);                      // boş paragraf atılır
    expect(slides[1].paragraphs).toEqual(['İkinci', 'alt satır']);
  });
});

describe('tablo yardımcıları', () => {
  it('sütun adları Excel gibi: A…Z, AA…', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
  it('hücre değerleri', () => {
    expect([null, undefined, 3.5, true, false, 'ş', new Date('invalid')].map(formatCell)).toEqual(['', '', '3.5', 'DOĞRU', 'YANLIŞ', 'ş', '']);
  });
});
