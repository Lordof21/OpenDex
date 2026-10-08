// Hızlı önizleme (Quick Look): Boşluk ya da Enter ile açılır, ←/→ klasördeki önizlenebilir diğer dosyalara geçer, Esc/Boşluk
// kapatır. Resim/video/ses tarayıcıya doğrudan `/api/fs/content` ile akar (Range destekli; telefon dosyası arka uçta BELLEĞE
// alınır, diske yazılmaz); metin ilk 1 MB'tır; PDF/DOCX/XLSX/PPTX salt okunur ve bellekte çizilir (DocumentBodies.jsx).
// Komşu resimler önden yüklenir: ok tuşuyla gezinmek anlıktır.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, Music, Save, X } from 'lucide-react';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { IconButton } from '../ui/IconButton.jsx';
import { DocxBody, PdfBody, SheetBody, SlidesBody } from './DocumentBodies.jsx';
import { contentUrl, fetchText } from './fsApi.js';
import { entryLoc, openOnPc, sendSelection } from './filesCommands.js';
import { canThumbnail, previewKind } from './fileTypes.js';
import { keyOf, useFilesStore } from './filesStore.js';
import { formatSize } from './formatters.js';
import { isPhone } from './paths.js';
import PreviewFailed from './PreviewFailed.jsx';
import { useThumbnail } from './useThumbnail.js';

const TEXT_LIMIT = 1_000_000;
const PRELOAD_MAX_BYTES = 20 * 1024 * 1024;

const canPreview = (entry) => entry.kind !== 'dir' && Boolean(previewKind(entry));

function TextBody({ loc, entry }) {
  const [state, setState] = useState({ status: 'loading', text: '' });
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: 'loading', text: '' });
    fetchText(loc, TEXT_LIMIT, ctrl.signal)
      .then((text) => setState({ status: 'ready', text }))
      .catch((err) => { if (err?.name !== 'AbortError') setState({ status: 'error', text: '', message: err.code === 'too_large' ? 'Dosya önizleme için çok büyük.' : err.message }); });
    return () => ctrl.abort();
  }, [loc.path, loc.provider, loc.device, entry.mtime]);                     // eslint-disable-line react-hooks/exhaustive-deps
  if (state.status === 'loading') return <LoaderCircle className="size-6 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Yükleniyor" />;
  if (state.status === 'error') return <PreviewFailed message={state.message} />;
  return (
    <div className="flex h-full w-full max-w-3xl flex-col">
      <pre tabIndex={0} className="dex-scroll min-h-0 flex-1 overflow-auto rounded-lg border border-border/70 bg-background p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground">{state.text}</pre>
      {entry.size > TEXT_LIMIT && <p className="mt-1.5 text-center text-[11px] text-muted-foreground">İlk {formatSize(TEXT_LIMIT)} gösteriliyor ({formatSize(entry.size)} dosyanın).</p>}
    </div>
  );
}

// Video/ses telefondan oynarken aralıklı okunur (boyut sınırı yok); oynatılamıyorsa (codec) nedeni ve çıkışı söylenir.
const MEDIA_FAILED = 'Bu dosya burada oynatılamadı (biçim ya da codec desteklenmiyor olabilir). Bilgisayarın oynatıcısında açabilirsiniz.';

/** Müzik: albüm kapağı (varsa, telefonun kendi çözücüsünden) + oynatıcı. Ses doğrudan akar, otomatik başlar. */
function AudioBody({ loc, entry, url, onError }) {
  const cover = useThumbnail(loc, entry, 320, canThumbnail(entry, loc.provider));
  return (
    <div className="flex flex-col items-center gap-4">
      {cover
        ? <img src={cover} alt="" draggable={false} className="size-48 rounded-xl object-cover shadow-window" />
        : <Music className="size-16 opacity-70" strokeWidth={1.2} aria-hidden="true" />}
      <audio key={url} src={url} controls autoPlay onError={onError} className="w-80 max-w-full" />
    </div>
  );
}

export default function PreviewOverlay({ winId }) {
  const preview = useFilesStore((s) => s.wins[winId]?.preview);
  const pane = useFilesStore((s) => (preview ? s.wins[winId]?.panes[preview.pane] : null));
  const root = useRef(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const store = useFilesStore;

  const at = pane && preview ? pane.indexMap.get(preview.key) : undefined;
  const entry = at !== undefined ? pane.visible[at] : null;
  const kind = entry ? previewKind(entry) : null;
  const loc = entry ? entryLoc(pane, entry) : null;
  const url = useMemo(() => (loc && (kind === 'image' || kind === 'video' || kind === 'audio') ? contentUrl(loc) : null),
    [loc?.path, loc?.provider, loc?.device, entry?.mtime, kind]);                // eslint-disable-line react-hooks/exhaustive-deps
  const previewables = useMemo(() => (pane ? pane.visible.filter(canPreview) : []), [pane?.visible]);          // eslint-disable-line react-hooks/exhaustive-deps
  const position = entry ? previewables.findIndex((e) => keyOf(e) === keyOf(entry)) + 1 : 0;

  const close = () => {
    const paneId = pane?.id;
    store.getState().closePreview(winId);
    requestAnimationFrame(() => document.querySelector(`[data-pane="${paneId}"] [data-files-scroll]`)?.focus({ preventScroll: true }));
  };
  const step = (delta) => store.getState().stepPreview(winId, delta, canPreview);

  useEffect(() => { setLoaded(false); setFailed(false); }, [url, entry && keyOf(entry)]);          // eslint-disable-line react-hooks/exhaustive-deps

  // Dosya silindi / klasör değişti: önizleme kapanır.
  useEffect(() => { if (preview && !entry) store.getState().closePreview(winId); }, [preview, entry, store, winId]);

  useEffect(() => {
    if (!preview) return undefined;
    const off = pushEscapeHandler(close);
    const onKey = (e) => {
      if (e.target.closest?.('input,textarea')) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); step(-1); }
      else if (e.key === ' ' && e.target.tagName !== 'VIDEO' && e.target.tagName !== 'AUDIO') { e.preventDefault(); e.stopPropagation(); close(); }
    };
    window.addEventListener('keydown', onKey, true);
    root.current?.focus();
    return () => { off(); window.removeEventListener('keydown', onKey, true); };
  }, [Boolean(preview)]);                                                                         // eslint-disable-line react-hooks/exhaustive-deps

  // Komşu resimleri önden yükle (telefonda ilk istek adb çekimidir: sıradaki resim hazır olsun).
  useEffect(() => {
    if (!entry || !pane) return;
    for (const delta of [1, -1]) {
      const next = pane.visible[at + delta];
      if (next && previewKind(next) === 'image' && next.size <= PRELOAD_MAX_BYTES) new Image().src = contentUrl(entryLoc(pane, next));
    }
  }, [at, pane?.visible]);                                                                         // eslint-disable-line react-hooks/exhaustive-deps

  if (!preview || !entry) return null;
  const phone = isPhone(loc);
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`Önizleme: ${entry.name}`}
      tabIndex={-1}
      className="absolute inset-0 z-40 flex flex-col bg-scrim/85 text-scrim-foreground outline-none backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" title={entry.name}>{entry.name}</p>
          <p className="text-[11px] opacity-75 tabular-nums">{position} / {previewables.length} · {formatSize(entry.size)}</p>
        </div>
        {/* Başlık pencerenin en üstünde: varsayılan (yukarı açılan) ipucu kırpılır → aşağı; en sağdaki sağa hizalı (kenardan taşmasın). */}
        <IconButton label="Bilgisayarda aç" tone="scrim" size="md" tooltipPosition="bottom" onClick={() => openOnPc(loc)}><ExternalLink /></IconButton>
        {phone && <IconButton label="Bilgisayara kaydet" tone="scrim" size="md" tooltipPosition="bottom" onClick={() => sendSelection(winId, preview.pane, 'pc')}><Save /></IconButton>}
        <IconButton label="Kapat (Esc)" tone="scrim" size="md" tooltipPosition="bottom" tooltipAlign="end" onClick={close}><X /></IconButton>
      </header>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-14 pb-4" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
        {/* IconButton kendi `relative` sınıfını taşır (CSS'te `absolute`'un ÜSTÜNDE): konumlama sarmalayıcıda. */}
        <span className="absolute left-2 top-1/2 -translate-y-1/2"><IconButton label="Önceki (←)" tone="scrim" shape="full" size="lg" disabled={position <= 1} onClick={() => step(-1)}><ChevronLeft /></IconButton></span>
        <span className="absolute right-2 top-1/2 -translate-y-1/2"><IconButton label="Sonraki (→)" tone="scrim" shape="full" size="lg" disabled={position >= previewables.length} onClick={() => step(1)}><ChevronRight /></IconButton></span>
        {failed ? (
          <PreviewFailed message={kind === 'video' || kind === 'audio' ? MEDIA_FAILED : undefined} onOpen={() => openOnPc(loc)} />
        ) : kind === 'image' ? (
          <>
            {!loaded && <LoaderCircle className="absolute size-6 animate-spin motion-reduce:animate-none" aria-label="Yükleniyor" />}
            <img key={url} src={url} alt={entry.name} draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} className={`max-h-full max-w-full rounded-md object-contain shadow-window transition-opacity duration-150 ${loaded ? 'opacity-100' : 'opacity-0'}`} />
          </>
        ) : kind === 'video' ? (
          <video key={url} src={url} controls autoPlay playsInline onError={() => setFailed(true)} className="max-h-full max-w-full rounded-md bg-black shadow-window" />
        ) : kind === 'audio' ? (
          <AudioBody loc={loc} entry={entry} url={url} onError={() => setFailed(true)} />
        ) : kind === 'pdf' ? (
          <PdfBody key={keyOf(entry)} loc={loc} entry={entry} onOpen={() => openOnPc(loc)} />
        ) : kind === 'docx' ? (
          <DocxBody key={keyOf(entry)} loc={loc} entry={entry} onOpen={() => openOnPc(loc)} />
        ) : kind === 'xlsx' ? (
          <SheetBody key={keyOf(entry)} loc={loc} entry={entry} onOpen={() => openOnPc(loc)} />
        ) : kind === 'pptx' ? (
          <SlidesBody key={keyOf(entry)} loc={loc} entry={entry} onOpen={() => openOnPc(loc)} />
        ) : (
          <TextBody loc={loc} entry={entry} />
        )}
      </div>
    </div>
  );
}
