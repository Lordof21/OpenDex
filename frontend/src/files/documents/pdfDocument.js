// PDF → bellekte açılan, sayfa sayfa çizilen belge (pdf.js). Baytlar hiçbir yere yazılmaz; sayfalar yalnız görünür
// olduklarında canvas'a çizilir. Eski (legacy) derleme: eski WebView'lerde de çalışır.
//
// Bilerek kapalı: WebAssembly (`useWasm: false` — uygulamanın CSP'sinde `wasm-unsafe-eval` yok; JPX/JBIG2 için JS yolu
// kullanılır), XFA formları, betikler. `useSystemFonts`: gömülü olmayan temel yazı tipleri sistemden gelir.
let libraryPromise;

function library() {
  libraryPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return libraryPromise;
}

const failure = (code, message) => Object.assign(new Error(message), { code });

/** ArrayBuffer (.pdf) → { pageCount, pageRatio(n), render(n, canvas, cssWidth), destroy() }. */
export async function openPdf(buffer) {
  const pdfjs = await library();
  // getDocument() dönüşü (loadingTask) ile onun .promise'inin çözdüğü değer (doc, PDFDocumentProxy)
  // AYRI nesneler: .destroy() yalnız loadingTask'ta var — doc'ta YOK (pdf.js'in kendi tip
  // tanımları da bunu doğruluyor). doc.destroy() çağırmak önizleme kapanırken "doc.destroy is
  // not a function" fırlatıp siyah ekrana düşürüyordu VE worker/bellek hiçbir zaman serbest kalmıyordu.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer), useWasm: false, enableXfa: false, useSystemFonts: true, stopAtErrors: false,
  });
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (err) {
    if (err?.name === 'PasswordException') throw failure('password', 'Bu PDF parola korumalı; önizlenemiyor.');
    throw failure('invalid', 'PDF okunamadı (bozuk ya da desteklenmeyen dosya).');
  }
  return {
    pageCount: doc.numPages,
    /** Yükseklik/genişlik oranı (sayfa çizilmeden yer ayırmak için). */
    async pageRatio(number) {
      const view = (await doc.getPage(number)).getViewport({ scale: 1 });
      return view.height / view.width;
    },
    /** Sayfayı `cssWidth` CSS pikselinde canvas'a çizer; iptal edilebilir söz döner. */
    render(number, canvas, cssWidth) {
      let task;
      let cancelled = false;
      const done = (async () => {
        const page = await doc.getPage(number);
        if (cancelled) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${viewport.height / dpr}px`;
        task = page.render({ canvas, viewport });
        await task.promise;
      })();
      done.cancel = () => { cancelled = true; task?.cancel(); };
      return done;
    },
    destroy: () => loadingTask.destroy(),
  };
}
