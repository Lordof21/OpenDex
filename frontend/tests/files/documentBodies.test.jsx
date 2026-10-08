// Belge gövdeleri: baytlar bellekten gelir (fetchBytes), çözücü gerçek (PDF hariç: pdf.js worker ister), çıktı sandbox içinde.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { strToU8, zipSync } from 'fflate';
import { ApiError } from '../../src/lib/api.js';

vi.mock('../../src/files/fsApi.js', () => ({ fetchBytes: vi.fn() }));
vi.mock('../../src/files/documents/pdfDocument.js', () => ({ openPdf: vi.fn() }));

import { fetchBytes } from '../../src/files/fsApi.js';
import { openPdf } from '../../src/files/documents/pdfDocument.js';
import { DocxBody, PdfBody, SlidesBody } from '../../src/files/DocumentBodies.jsx';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const loc = { provider: 'phone', path: '/sdcard/Download/rapor.docx' };
const entry = { name: 'rapor.docx', size: 10, mtime: 1 };
const zipBuffer = (files) => {
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([n, t]) => [n, strToU8(t)])));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

describe('DOCX gövdesi', () => {
  it('belge betiksiz sandbox iframe’inde (hiçbir izin yok) gösterilir ve salt okunur uyarısı vardır', async () => {
    fetchBytes.mockResolvedValue(zipBuffer({
      '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Yıllık rapor</w:t></w:r></w:p></w:body></w:document>',
    }));
    render(<DocxBody loc={loc} entry={entry} />);
    const frame = await screen.findByTitle('Belge: rapor.docx');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('Yıllık rapor');
    expect(screen.getByText(/Salt okunur önizleme/)).toBeTruthy();
    expect(fetchBytes).toHaveBeenCalledWith(loc, 96 * 1024 * 1024, expect.any(AbortSignal));
  });

  it('çok büyük dosya: nedeni söyler ve "Bilgisayarda aç" çıkışı verir', async () => {
    fetchBytes.mockRejectedValue(new ApiError(413, 'x', { code: 'too_large' }));
    const onOpen = vi.fn();
    render(<DocxBody loc={loc} entry={entry} onOpen={onOpen} />);
    expect(await screen.findByText('Dosya önizleme için çok büyük.')).toBeTruthy();
    screen.getByText('Bilgisayarda aç').click();
    expect(onOpen).toHaveBeenCalled();
  });

  it('bozuk belge: genel ve anlaşılır bir hata', async () => {
    fetchBytes.mockResolvedValue(new TextEncoder().encode('bu bir zip değil').buffer);
    render(<DocxBody loc={loc} entry={entry} />);
    expect(await screen.findByText(/Belge okunamadı/)).toBeTruthy();
  });
});

describe('PPTX gövdesi', () => {
  it('slayt metinleri listelenir', async () => {
    fetchBytes.mockResolvedValue(zipBuffer({
      'ppt/slides/slide1.xml': '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><a:p><a:r><a:t>Açılış</a:t></a:r></a:p></p:sld>',
    }));
    render(<SlidesBody loc={loc} entry={{ ...entry, name: 'sunum.pptx' }} />);
    expect(await screen.findByText('Açılış')).toBeTruthy();
    expect(screen.getByText('Slayt 1')).toBeTruthy();
  });
});

describe('PDF gövdesi', () => {
  it('sayfalar çizilir; parola korumalı PDF’te neden gösterilir; kapanınca belge bırakılır', async () => {
    const pdf = { pageCount: 5, pageRatio: vi.fn().mockResolvedValue(1.4), render: vi.fn(() => Object.assign(Promise.resolve(), { cancel: vi.fn() })), destroy: vi.fn() };
    fetchBytes.mockResolvedValue(new ArrayBuffer(8));
    openPdf.mockResolvedValue(pdf);
    const { unmount } = render(<PdfBody loc={loc} entry={{ ...entry, name: 'a.pdf' }} />);
    await waitFor(() => expect(screen.getByLabelText('PDF, 5 sayfa')).toBeTruthy());
    await waitFor(() => expect(pdf.render).toHaveBeenCalled());
    unmount();
    expect(pdf.destroy).toHaveBeenCalledTimes(1);                              // belleğe alınan belge serbest bırakılır

    openPdf.mockRejectedValue(Object.assign(new Error('Bu PDF parola korumalı; önizlenemiyor.'), { code: 'password' }));
    render(<PdfBody loc={loc} entry={{ ...entry, name: 'b.pdf' }} />);
    expect(await screen.findByText('Bu PDF parola korumalı; önizlenemiyor.')).toBeTruthy();
  });
});
