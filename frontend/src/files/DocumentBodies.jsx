// Belge önizlemesi (PDF, DOCX, XLSX, PPTX): salt okunur, TAMAMEN BELLEKTE. Baytlar /api/fs/content'ten `fetch` ile bir
// ArrayBuffer'a alınır, tarayıcıda çözülür ve çizilir; ne arka uç ne tarayıcı diske yazar (fsApi.fetchBytes: no-store).
// Dosya ancak kullanıcı "Bilgisayara kaydet"/indir derse diske gider. Düzenleme yok: düzenlemek için telefondaki uygulama
// ya da bilgisayara kaydedip açmak. Çözücüler (pdf.js, mammoth, read-excel-file, fflate) ilk kullanımda yüklenir.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { ApiError } from '../lib/api.js';
import { DOC_PREVIEW_MAX_BYTES } from './fileTypes.js';
import { fetchBytes } from './fsApi.js';
import { openPdf } from './documents/pdfDocument.js';
import { docxToDocument } from './documents/docxDocument.js';
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, formatCell, readWorkbook } from './documents/workbook.js';
import { readSlides } from './documents/slides.js';
import PreviewFailed from './PreviewFailed.jsx';

const READ_ONLY_NOTE = 'Salt okunur önizleme — düzenlemek için telefondaki uygulamayı kullanın ya da bilgisayara kaydedip açın.';

function messageOf(err) {
  if (err?.code === 'too_large') return 'Dosya önizleme için çok büyük.';
  if (err?.code === 'password' || err?.code === 'invalid') return err.message;
  if (err instanceof ApiError) return err.message;
  return 'Belge okunamadı (bozuk, parola korumalı ya da desteklenmeyen dosya).';
}

/** Baytları getirir ve `convert` ile çözer. `dispose(değer)`: bileşen kalkınca (ya da dosya değişince) bırakılacak kaynak. */
function useDocument(loc, entry, convert, dispose) {
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    const ctrl = new AbortController();
    let gone = false;
    let value;
    setState({ status: 'loading' });
    (async () => {
      value = await convert(await fetchBytes(loc, DOC_PREVIEW_MAX_BYTES, ctrl.signal));
      if (gone) { dispose?.(value); value = undefined; return; }
      setState({ status: 'ready', value });
    })().catch((err) => { if (!gone && err?.name !== 'AbortError') setState({ status: 'error', message: messageOf(err) }); });
    return () => { gone = true; ctrl.abort(); if (value !== undefined) dispose?.(value); };
  }, [loc.provider, loc.path, loc.device, entry.mtime, entry.size]);                // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function Frame({ state, onOpen, children }) {
  if (state.status === 'loading') return <LoaderCircle className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Yükleniyor" />;
  if (state.status === 'error') return <PreviewFailed message={state.message} onOpen={onOpen} />;
  return (
    <div className="flex h-full w-full max-w-4xl flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      <p className="mt-1.5 text-center text-[11px] text-scrim-foreground/70">{READ_ONLY_NOTE}</p>
    </div>
  );
}

// ── PDF ────────────────────────────────────────────────────────────────────────────────────────────
function PdfPage({ pdf, number, width, ratio, root }) {
  const holder = useRef(null);
  const canvas = useRef(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined' && number <= 3);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !holder.current) return undefined;
    const observer = new IntersectionObserver(([hit]) => setNear(hit.isIntersecting), { root, rootMargin: '700px 0px' });
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, [root]);

  // Yalnız görünürlüğe yakın sayfalar çizilir; uzaklaşınca canvas boşaltılır (büyük PDF'te bellek sınırlı kalır).
  useEffect(() => {
    if (!near || !width || !canvas.current) return undefined;
    const target = canvas.current;
    const job = pdf.render(number, target, width);
    job.catch(() => {});
    return () => { job.cancel(); target.width = 0; target.height = 0; };
  }, [near, width, pdf, number]);

  return (
    <div ref={holder} style={{ width, minHeight: width * ratio }} className="mx-auto mb-3 bg-white shadow-window" data-page={number}>
      <canvas ref={canvas} className="block" aria-label={`Sayfa ${number}`} />
    </div>
  );
}

function PdfPages({ pdf }) {
  const [host, setHost] = useState(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(1.414);
  useEffect(() => {
    if (!host) return undefined;
    const measure = () => setWidth(Math.max(240, Math.min(Math.floor(host.clientWidth - 24), 900)));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [host]);
  useEffect(() => { let live = true; pdf.pageRatio(1).then((r) => { if (live && r > 0) setRatio(r); }).catch(() => {}); return () => { live = false; }; }, [pdf]);
  const numbers = useMemo(() => Array.from({ length: pdf.pageCount }, (_, i) => i + 1), [pdf]);
  return (
    <div ref={setHost} tabIndex={0} aria-label={`PDF, ${pdf.pageCount} sayfa`} className="dex-scroll h-full overflow-auto rounded-lg bg-muted/40 p-3">
      {numbers.map((n) => <PdfPage key={n} pdf={pdf} number={n} width={width} ratio={ratio} root={host} />)}
    </div>
  );
}

export function PdfBody({ loc, entry, onOpen }) {
  const state = useDocument(loc, entry, openPdf, (pdf) => pdf.destroy());
  return <Frame state={state} onOpen={onOpen}>{state.status === 'ready' && <PdfPages pdf={state.value} />}</Frame>;
}

// ── DOCX ───────────────────────────────────────────────────────────────────────────────────────────
export function DocxBody({ loc, entry, onOpen }) {
  const state = useDocument(loc, entry, docxToDocument);
  const doc = state.status === 'ready' ? state.value : null;
  return (
    <Frame state={state} onOpen={onOpen}>
      {doc && (doc.empty
        ? <p className="grid h-full place-items-center text-sm opacity-80">Bu belgede gösterilecek içerik yok.</p>
        // sandbox="" (hiçbir izin yok): betik çalışmaz, form/pencere/gezinme yok, kaynak ayrı bir köken. srcDoc kendi CSP'sini taşır.
        : <iframe title={`Belge: ${entry.name}`} sandbox="" srcDoc={doc.srcdoc} className="h-full w-full rounded-lg bg-white" />)}
    </Frame>
  );
}

// ── XLSX ───────────────────────────────────────────────────────────────────────────────────────────
export function columnName(index) {
  let n = index;
  let out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

function SheetTable({ sheet }) {
  const cols = Math.min(sheet.totalCols, SHEET_MAX_COLS);
  const cut = sheet.totalRows > sheet.rows.length || sheet.totalCols > cols;
  return (
    <div className="flex h-full flex-col">
      <div className="dex-scroll min-h-0 flex-1 overflow-auto rounded-lg border border-border/70 bg-background">
        <table className="min-w-full border-collapse text-xs text-foreground">
          <thead className="sticky top-0 bg-muted text-muted-foreground">
            <tr><th className="w-10 border border-border/60 px-1.5 py-1" />{Array.from({ length: cols }, (_, c) => <th key={c} className="border border-border/60 px-2 py-1 font-medium">{columnName(c)}</th>)}</tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, r) => (
              <tr key={r}>
                <th className="border border-border/60 bg-muted/60 px-1.5 py-0.5 text-right font-normal tabular-nums text-muted-foreground">{r + 1}</th>
                {Array.from({ length: cols }, (_, c) => <td key={c} className="max-w-[18rem] truncate border border-border/50 px-2 py-0.5 tabular-nums" title={formatCell(row[c])}>{formatCell(row[c])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cut && <p className="mt-1 text-center text-[11px] text-scrim-foreground/75">İlk {sheet.rows.length} satır / {cols} sütun gösteriliyor (toplam {sheet.totalRows} × {sheet.totalCols}).</p>}
    </div>
  );
}

export function SheetBody({ loc, entry, onOpen }) {
  const state = useDocument(loc, entry, readWorkbook);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [loc.path, entry.mtime]);                           // eslint-disable-line react-hooks/exhaustive-deps
  const sheets = state.status === 'ready' ? state.value : [];
  const sheet = sheets[Math.min(active, sheets.length - 1)];
  return (
    <Frame state={state} onOpen={onOpen}>
      {sheet && (
        <div className="flex h-full flex-col gap-1.5">
          {sheets.length > 1 && (
            <div role="tablist" aria-label="Sayfalar" className="flex gap-1 overflow-x-auto">
              {sheets.map((s, i) => (
                <button key={s.name + i} type="button" role="tab" aria-selected={i === active} onClick={() => setActive(i)}
                  className={`shrink-0 rounded-md px-2.5 py-1 text-xs cursor-pointer ${i === active ? 'bg-scrim-foreground/20 font-semibold' : 'hover:bg-scrim-foreground/10'}`}>{s.name}</button>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1"><SheetTable sheet={sheet} /></div>
        </div>
      )}
    </Frame>
  );
}

// ── PPTX ───────────────────────────────────────────────────────────────────────────────────────────
export function SlidesBody({ loc, entry, onOpen }) {
  const state = useDocument(loc, entry, readSlides);
  const slides = state.status === 'ready' ? state.value : [];
  return (
    <Frame state={state} onOpen={onOpen}>
      <div className="flex h-full flex-col gap-1.5">
        <p className="text-[11px] text-scrim-foreground/75">Sunumun metin özeti — slaytların görünümü için dosyayı uygulamasında açın.</p>
        <div className="dex-scroll min-h-0 flex-1 space-y-2 overflow-auto">
          {slides.length === 0 && <p className="text-sm text-scrim-foreground/80">Bu sunumda metin bulunamadı.</p>}
          {slides.map((slide) => (
            <section key={slide.number} className="rounded-lg border border-border/70 bg-background p-3 text-foreground">
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Slayt {slide.number}</h3>
              {slide.paragraphs.length === 0 ? <p className="text-xs text-muted-foreground">(metin yok)</p> : slide.paragraphs.map((text, i) => <p key={i} className={`text-sm ${i === 0 ? 'font-semibold' : ''}`}>{text}</p>)}
            </section>
          ))}
        </div>
      </div>
    </Frame>
  );
}
