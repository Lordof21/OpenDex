// pdf.js API sözleşmesi: getDocument(...) döndürdüğü PDFDocumentLoadingTask'ta .destroy() VAR, ama onun .promise'inin
// çözdüğü PDFDocumentProxy'de (openPdf'teki `doc`) YOK — openPdf bunu karıştırıp `doc.destroy()` çağırırsa önizleme
// kapanırken "doc.destroy is not a function" fırlatır (siyah ekran) ve worker/belleği hiçbir zaman serbest bırakmaz.
import { afterEach, describe, expect, it, vi } from 'vitest';

const getDocument = vi.fn();

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument, GlobalWorkerOptions: {} }));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: 'worker-url' }));

import { openPdf } from '../../src/files/documents/pdfDocument.js';

afterEach(() => { vi.clearAllMocks(); });

describe('openPdf', () => {
  it('destroy() PDFDocumentProxy\'yi değil, getDocument\'in döndürdüğü loadingTask\'ı kapatır', async () => {
    const fakeDoc = { numPages: 3 }; // gerçek PDFDocumentProxy'de .destroy() YOK — bilerek eklemedik
    const loadingTaskDestroy = vi.fn().mockResolvedValue(undefined);
    getDocument.mockReturnValue({ promise: Promise.resolve(fakeDoc), destroy: loadingTaskDestroy });

    const pdf = await openPdf(new ArrayBuffer(8));
    expect(pdf.pageCount).toBe(3);

    await expect(pdf.destroy()).resolves.toBeUndefined(); // eskiden: doc.destroy() -> TypeError
    expect(loadingTaskDestroy).toHaveBeenCalledTimes(1);
  });

  it('parola korumalı PDF anlaşılır bir hataya çevrilir', async () => {
    getDocument.mockReturnValue({
      promise: Promise.reject(Object.assign(new Error('x'), { name: 'PasswordException' })),
      destroy: vi.fn(),
    });

    await expect(openPdf(new ArrayBuffer(8))).rejects.toMatchObject({ code: 'password' });
  });
});
