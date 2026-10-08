// PPTX → slayt başına metin özeti (bellekte). Slaytların görünümü (şekil, resim, yerleşim) çizilmez; sunumun içeriğini
// hızla okumaya yeter. PPTX bir zip'tir: yalnız slayt XML'leri açılır, her biri sınırlı boyutta (zip bombasına karşı).
const SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/;
const MAX_SLIDE_XML_BYTES = 4 * 1024 * 1024;
export const MAX_SLIDES = 300;
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/** Slayt XML'i → paragraf metinleri (boşlar atılır). */
export function slideParagraphs(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const paragraphs = [];
  for (const p of Array.from(doc.getElementsByTagNameNS(A_NS, 'p'))) {
    const text = Array.from(p.getElementsByTagNameNS(A_NS, 't')).map((t) => t.textContent).join('').trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

/** ArrayBuffer (.pptx) → [{ number, paragraphs }] (slayt sırasıyla). */
export async function readSlides(buffer) {
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (file) => SLIDE.test(file.name) && file.originalSize <= MAX_SLIDE_XML_BYTES,
  });
  return Object.entries(files)
    .map(([name, bytes]) => ({ number: Number(SLIDE.exec(name)[1]), xml: strFromU8(bytes) }))
    .sort((a, b) => a.number - b.number)
    .slice(0, MAX_SLIDES)
    .map(({ number, xml }) => ({ number, paragraphs: slideParagraphs(xml) }));
}
