// Masaüstü → sağ tık → "Arka planı değiştir…". Kapak resmi galerisi, kullanıcı resimleri, düz renkler ve ince ayarlar.
//
//   - Seçim ANINDA masaüstüne uygulanır (canlı); "Uygula" adımı yok. Geri dönüş: "Geri al" (pencere açılırken ki hâle) ve
//     "Varsayılana dön". Arka plan hafif karartılır ama bulanıklaştırılmaz: değişiklik arkada gerçek masaüstünde görünür.
//   - Galeri: açık/koyu eşli hazır kapaklar (tema ile birlikte değişir; "Hep açık/koyu" seçilebilir) — kod ile çizilir, dosya yok.
//   - Resimlerim: seç / sürükle-bırak / Ctrl+V ile ekle; 4K'ya küçültülür, tarayıcı deposunda (IndexedDB) kalır, silme geri alınır.
//   - Renkler: 18 düz renk + özel renk. Ayarlar: yerleşim (doldur/sığdır/uzat/ortala/döşe), bulanıklık, karartma, slayt gösterisi.
//   - Klavye: ok tuşları karolar arasında gezer, Enter/Boşluk seçer, Esc kapatır.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ImagePlus, Images, Palette, RotateCcw, Shuffle, Trash2, Undo2, Upload, X, Sparkles } from 'lucide-react';
import { Button } from '../../ui/Button.jsx';
import { Dialog } from '../../ui/Dialog.jsx';
import { IconButton } from '../../ui/IconButton.jsx';
import { PrecisionSlider } from '../../ui/PrecisionSlider.jsx';
import { SegmentedControl } from '../../ui/SegmentedControl.jsx';
import { Switch } from '../../ui/Switch.jsx';
import { cn } from '../../lib/utils.js';
import { useTheme } from '../../state/ThemeContext.jsx';
import { BUILTIN_WALLPAPERS, CATEGORIES, SOLID_SWATCHES } from './catalog.js';
import { artStyle } from './layerStyle.js';
import { BLUR_MAX, DEFAULT_PREFS, DIM_MAX, MAX_IMAGES, SLIDESHOW_INTERVALS_MIN, isHexColor, resolveWallpaper } from './prefs.js';
import { useWallpaper } from './useWallpaper.js';
import { useWallpaperStore } from './wallpaperStore.js';
import { ChoiceGrid, PreviewStage, Tile, focusableIndex, useThumbUrls } from './WallpaperParts.jsx';
import { t } from '../../i18n/index.js';

const STATUS_MS = 8000;

const SOURCE_TABS = [
  { value: 'gallery', label: t('desktop.galeri'), icon: Sparkles },
  { value: 'mine', label: t('desktop.resimlerim'), icon: Images },
  { value: 'colors', label: t('desktop.renkler'), icon: Palette },
];
const CATEGORY_OPTIONS = [{ value: 'all', label: t('desktop.tumu') }, ...CATEGORIES.map((c) => ({ value: c.id, label: c.label }))];
const FIT_OPTIONS = [
  { value: 'fill', label: t('desktop.doldur'), title: t('desktop.ekrani_kaplar_tasan_kisim_kirpilir') },
  { value: 'fit', label: t('common.sigdir'), title: t('desktop.resmin_tamami_gorunur_kenarlar') },
  { value: 'stretch', label: t('desktop.uzat'), title: t('desktop.orani_bozarak_ekrani_doldurur') },
  { value: 'center', label: t('desktop.ortala'), title: t('desktop.gercek_boyutta_ortalar') },
  { value: 'tile', label: t('desktop.dose'), title: t('desktop.resmi_yan_yana_tekrarlar') },
];
const APPEARANCE_OPTIONS = [
  { value: 'auto', label: t('common.otomatik'), title: t('desktop.tema_ile_birlikte_acik_koyu_degisir') },
  { value: 'light', label: t('common.acik_2') },
  { value: 'dark', label: t('common.koyu') },
];
const SOURCE_OPTIONS = [
  { value: 'all', label: t('desktop.tum_kapaklar') },
  { value: 'builtin', label: t('desktop.hazir_kapaklar') },
  { value: 'images', label: t('desktop.resimlerim') },
];

export function intervalLabel(minutes) {
  if (minutes < 60) return `${minutes} dakika`;
  if (minutes < 1440) return `${minutes / 60} saat`;
  return t('desktop.value_gun', { value: minutes / 1440 });
}

function Field({ title, hint, children }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold">{title}</h3>
        {hint && <span className="truncate text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1 text-[10px] text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full rounded-md border border-border/70 bg-background px-2 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function EmptyNote({ icon: Icon, title, hint }) {
  return (
    <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-border/80 px-6 py-8 text-center">
      <div className="max-w-xs">
        <span className="mx-auto grid size-10 place-items-center rounded-xl bg-muted text-muted-foreground"><Icon className="size-5" strokeWidth={1.6} aria-hidden="true" /></span>
        <p className="mt-2.5 text-xs font-semibold">{title}</p>
        {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

// ── Sekmeler ────────────────────────────────────────────────────────────────────────────────────────────────

function GalleryTab({ prefs, isDark, onSelect }) {
  const [category, setCategory] = useState('all');
  const items = useMemo(() => BUILTIN_WALLPAPERS.filter((item) => category === 'all' || item.category === category), [category]);
  const selected = items.map((item) => prefs.mode === 'builtin' && prefs.id === item.id);
  const focusAt = focusableIndex(selected);
  return (
    <div className="space-y-3">
      <SegmentedControl label={t('desktop.kategori')} value={category} onChange={setCategory} options={CATEGORY_OPTIONS} />
      <ChoiceGrid label={t('desktop.hazir_kapaklar')} className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-3">
        {items.map((item, index) => {
          const wp = resolveWallpaper({ mode: 'builtin', id: item.id, appearance: prefs.appearance }, { isDark });
          return (
            <Tile key={item.id} name={item.name} selected={selected[index]} focusable={index === focusAt} onSelect={() => onSelect(item.id)}>
              <span className="absolute inset-0" style={artStyle(wp)} />
            </Tile>
          );
        })}
      </ChoiceGrid>
    </div>
  );
}

function ImagesTab({ prefs, images, thumbs, persistent, busy, problems, onPick, onSelect, onRemove, onDismissProblems }) {
  const inputRef = useRef(null);
  const full = images.length >= MAX_IMAGES;
  const selected = images.map((img) => prefs.mode === 'image' && prefs.id === img.id);
  const focusAt = focusableIndex(selected);
  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/avif,image/gif,image/bmp"
        className="hidden"
        aria-label={t('desktop.resim_dosyasi_sec')}
        data-testid="wallpaper-file-input"
        onChange={(event) => {
          onPick([...event.target.files]);
          event.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={full || busy > 0}
        onClick={() => inputRef.current?.click()}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-left transition-colors hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          {busy > 0 ? <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" /> : <ImagePlus className="size-5" aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold">
            {busy > 0 ? t('desktop.busy_resim_hazirlaniyor', { busy }) : full ? `En fazla ${MAX_IMAGES} resim eklenebilir` : t('desktop.resim_ekle')}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {full ? t('desktop.yeni_eklemek_icin_bir_resmi_silin') : t('desktop.secin_buraya_surukleyip_birakin_ya_da')}
          </span>
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{images.length} / {MAX_IMAGES}</span>
      </button>

      {problems.length > 0 && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px]">
          <div className="flex items-start gap-2">
            <ul className="min-w-0 flex-1 space-y-0.5 text-destructive">
              {problems.map((problem, index) => (
                <li key={`${problem.name}-${index}`}>{problem.message}</li>
              ))}
            </ul>
            <IconButton label={t('desktop.uyariyi_kapat')} size="xs" onClick={onDismissProblems}><X /></IconButton>
          </div>
        </div>
      )}

      {!persistent && images.length > 0 && (
        <p className="text-[10px] text-warning">{t('desktop.bu_ortamda_tarayici_depolamasi_kapali')}</p>
      )}

      {images.length === 0 ? (
        <EmptyNote icon={Images} title={t('desktop.henuz_resim_eklemediniz')} hint={t('desktop.kendi_fotografinizi_kapak_yapin')} />
      ) : (
        <ChoiceGrid label={t('desktop.resimlerim')} className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-3">
          {images.map((img, index) => (
            <Tile
              key={img.id}
              name={img.name}
              caption={`${img.name} · ${img.width}×${img.height}`}
              selected={selected[index]}
              focusable={index === focusAt}
              onSelect={() => onSelect(img.id)}
              actions={
                <span className="absolute left-1.5 top-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <IconButton label={t('desktop.name_resmini_sil', { name: img.name })} size="xs" shape="full" tooltip={false} danger="destructive" className="bg-popover/90 text-foreground shadow-md backdrop-blur" onClick={() => onRemove(img)}>
                    <Trash2 />
                  </IconButton>
                </span>
              }
            >
              {thumbs[img.id] ? (
                <span className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url("${thumbs[img.id]}")`, backgroundColor: img.avg }} />
              ) : (
                <span className="absolute inset-0 animate-pulse" style={{ backgroundColor: img.avg }} />
              )}
            </Tile>
          ))}
        </ChoiceGrid>
      )}
    </div>
  );
}

function ColorsTab({ prefs, onSelect }) {
  const [draft, setDraft] = useState(prefs.color);
  useEffect(() => setDraft(prefs.color), [prefs.color]);
  const selected = SOLID_SWATCHES.map((color) => prefs.mode === 'solid' && prefs.color === color);
  const focusAt = focusableIndex(selected);
  const commitDraft = (value) => {
    setDraft(value);
    if (isHexColor(value)) onSelect(value);
  };
  return (
    <div className="space-y-4">
      <ChoiceGrid label={t('desktop.duz_renkler')} className="grid grid-cols-6 gap-2.5 sm:grid-cols-9">
        {SOLID_SWATCHES.map((color, index) => (
          <button
            key={color}
            type="button"
            role="option"
            aria-selected={selected[index]}
            aria-label={t('desktop.renk_color', { color })}
            title={color}
            tabIndex={index === focusAt ? 0 : -1}
            onClick={() => onSelect(color)}
            style={{ backgroundColor: color }}
            className={cn(
              'aspect-square w-full cursor-pointer rounded-full ring-1 ring-border/80 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selected[index] && 'ring-2 ring-primary ring-offset-2 ring-offset-popover',
            )}
          />
        ))}
      </ChoiceGrid>
      <Field title={t('desktop.ozel_renk')} hint="#rrggbb">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={t('desktop.ozel_renk_secici')}
            value={isHexColor(prefs.color) ? prefs.color : DEFAULT_PREFS.color}
            onChange={(event) => commitDraft(event.target.value)}
            className="size-8 shrink-0 cursor-pointer rounded-md border border-border/70 bg-background p-0.5"
          />
          <input
            type="text"
            aria-label={t('desktop.renk_kodu')}
            value={draft}
            maxLength={7}
            spellCheck={false}
            onChange={(event) => commitDraft(event.target.value.startsWith('#') ? event.target.value : `#${event.target.value}`)}
            className={cn(
              'h-8 w-28 rounded-md border bg-background px-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring',
              isHexColor(draft) ? 'border-border/70' : 'border-destructive/60',
            )}
          />
        </div>
      </Field>
    </div>
  );
}

// ── Gövde ───────────────────────────────────────────────────────────────────────────────────────────────────

function WallpaperBody({ onClose }) {
  const headingId = useId();
  const { isDark } = useTheme();
  const wallpaper = useWallpaper();
  const prefs = useWallpaperStore((s) => s.prefs);
  const images = useWallpaperStore((s) => s.images);
  const persistent = useWallpaperStore((s) => s.persistent);
  const store = useWallpaperStore.getState;

  const [snapshot] = useState(() => store().prefs); // "Geri al" hedefi: pencere açılırken ki hâl
  const [tab, setTab] = useState(() => (prefs.mode === 'image' ? 'mine' : prefs.mode === 'solid' ? 'colors' : 'gallery'));
  const [busy, setBusy] = useState(0);
  const [problems, setProblems] = useState([]);
  const [status, setStatus] = useState(null); // { text, undo?: () => void }
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const thumbs = useThumbUrls(images);

  const changed = JSON.stringify(prefs) !== JSON.stringify(snapshot);
  const isDefault = JSON.stringify(prefs) === JSON.stringify(DEFAULT_PREFS);

  useEffect(() => {
    if (!status) return undefined;
    const timer = setTimeout(() => setStatus(null), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // Pencere kapanırken "silineni geri al" için tutulan baytlar bırakılır.
  useEffect(() => () => store().clearLastRemoved(), [store]);

  const importFiles = useCallback(
    async (files) => {
      const list = files.filter(Boolean);
      if (!list.length) return;
      setTab('mine');
      setProblems([]);
      setBusy(list.length);
      const { added, rejected } = await store().importFiles(list);
      setBusy(0);
      setProblems(rejected);
      if (added.length) setStatus({ text: added.length === 1 ? t('desktop.name_eklendi_ve_uygulandi', { name: added[0].name }) : t('desktop.count_resim_eklendi_ilki_uygulandi', { count: added.length }) });
    },
    [store],
  );

  // Ctrl+V: panodaki resim kapak resmi olarak eklenir (metin yapıştırma — ör. renk kodu — etkilenmez).
  useEffect(() => {
    const onPaste = (event) => {
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'));
      if (!files.length) return;
      event.preventDefault();
      importFiles(files);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [importFiles]);

  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
  const dropProps = {
    onDragEnter: (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDropping(true);
    },
    onDragOver: (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event) => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDropping(false);
    },
    onDrop: (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDropping(false);
      importFiles([...event.dataTransfer.files]);
    },
  };

  const removeImage = async (img) => {
    if (!(await store().removeImage(img.id))) return;
    setStatus({ text: t('desktop.name_silindi', { name: img.name }), undo: () => store().undoRemove().then(() => setStatus({ text: t('desktop.name_geri_getirildi', { name: img.name }) })) });
  };

  const previewThumb = wallpaper.kind === 'image' ? thumbs[wallpaper.imageId] ?? null : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" {...dropProps}>
      <header className="flex items-start gap-3 px-5 pb-3 pt-4">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/30">
          <Images className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-sm font-semibold leading-5">{t('desktop.arka_plan')}</h2>
          <p className="text-[11px] leading-4 text-muted-foreground [@media(max-height:560px)]:hidden">
            {t('desktop.sectiginiz_kapak_aninda_masaustune')}
          </p>
        </div>
        <IconButton label={t('common.kapat')} size="sm" onClick={onClose}><X /></IconButton>
      </header>

      {/* Geniş: solda önizleme + ayarlar, sağda kaynaklar (iki sütun). Dar: tek sütun ve sıra önizleme → kaynaklar → ayarlar
          (galeri, kaydırıcıların altında kalmasın); `contents` aside'ı dar düzende şeffaflaştırıp çocukları sıralanabilir kılar. */}
      <div className="dex-scroll flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-border/60 md:grid md:grid-cols-[minmax(250px,300px)_1fr] md:overflow-hidden">
        <aside className="dex-scroll contents md:block md:space-y-4 md:overflow-y-auto md:border-r md:border-border/60 md:px-5 md:py-4">
          <div className="order-1 shrink-0 space-y-2 px-5 pt-4 md:order-none md:p-0">
            <PreviewStage wallpaper={wallpaper} thumbUrl={previewThumb} />
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold" data-testid="wallpaper-current">{wallpaper.name}</p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {wallpaper.kind === 'image' ? t('desktop.resimlerim_2') : wallpaper.kind === 'solid' ? wallpaper.color.toUpperCase() : wallpaper.themed ? t('desktop.temayi_izler') : wallpaper.variant === 'dark' ? t('desktop.koyu_gorunum') : t('desktop.acik_gorunum')}
                </p>
              </div>
              <Button size="xs" variant="outline" startIcon={<Shuffle className="size-3" />} onClick={() => store().randomize()}>{t('desktop.rastgele')}</Button>
            </div>
          </div>
          <div className="order-3 shrink-0 space-y-4 px-5 pb-4 md:order-none md:p-0">
          {prefs.mode === 'builtin' && !wallpaper.themed && (
            <Field title={t('common.gorunum')} hint={prefs.appearance === 'auto' ? t('desktop.tema_ile_degisir') : undefined}>
              <SegmentedControl label={t('common.gorunum')} value={prefs.appearance} onChange={(value) => store().setAppearance(value)} options={APPEARANCE_OPTIONS} />
            </Field>
          )}
          {prefs.mode === 'image' && (
            <Field title={t('desktop.yerlesim')}>
              <SegmentedControl label={t('desktop.yerlesim')} value={prefs.fit} onChange={(value) => store().setFit(value)} options={FIT_OPTIONS} className="flex-wrap rounded-2xl" />
            </Field>
          )}

          <Field title={t('desktop.bulaniklik')} hint={prefs.blur ? t('desktop.blur_px', { blur: prefs.blur }) : t('common.kapali_2')}>
            <PrecisionSlider value={prefs.blur} min={0} max={BLUR_MAX} step={1} unit="px" label={t('desktop.bulaniklik')} showButtons={false} onChange={(value) => store().setBlur(value)} />
          </Field>
          <Field title={t('desktop.karartma')} hint={prefs.dim ? `%${prefs.dim}` : t('common.kapali_2')}>
            <PrecisionSlider value={prefs.dim} min={0} max={DIM_MAX} step={1} unit="%" label={t('desktop.karartma')} showButtons={false} onChange={(value) => store().setDim(value)} />
          </Field>

          <Field title={t('desktop.slayt_gosterisi')} hint={prefs.slideshow.enabled ? t('desktop.her_intervallabel', { intervalLabel: intervalLabel(prefs.slideshow.intervalMin) }) : t('common.kapali_2')}>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
              <span className="text-[11px] text-muted-foreground">{t('desktop.kapagi_kendiliginden_degistir')}</span>
              <Switch checked={prefs.slideshow.enabled} label={t('desktop.slayt_gosterisi')} onChange={() => store().setSlideshow({ enabled: !prefs.slideshow.enabled })} />
            </div>
            {prefs.slideshow.enabled && (
              <div className="space-y-1.5">
                <div className="flex gap-2">
                  <Select
                    label={t('desktop.sure')}
                    value={prefs.slideshow.intervalMin}
                    onChange={(value) => store().setSlideshow({ intervalMin: Number(value) })}
                    options={SLIDESHOW_INTERVALS_MIN.map((minutes) => ({ value: minutes, label: intervalLabel(minutes) }))}
                  />
                  <Select label={t('desktop.kaynak')} value={prefs.slideshow.source} onChange={(value) => store().setSlideshow({ source: value })} options={SOURCE_OPTIONS} />
                </div>
                {prefs.slideshow.source === 'images' && images.length === 0 && (
                  <p className="text-[10px] text-warning">{t('desktop.slayt_gosterisi_icin_once_resimlerim')}</p>
                )}
              </div>
            )}
          </Field>
          </div>
        </aside>

        {/* Sağ: kaynak sekmeleri */}
        <section className="dex-scroll order-2 flex shrink-0 flex-col md:order-none md:min-h-0 md:overflow-y-auto" aria-label={t('desktop.kapak_kaynagi')}>
          <div className="sticky top-0 z-10 bg-popover/95 px-5 pb-2 pt-4 backdrop-blur">
            <SegmentedControl
              label={t('desktop.kapak_kaynagi')}
              value={tab}
              onChange={setTab}
              size="md"
              options={SOURCE_TABS.map((item) => ({ ...item, label: item.value === 'mine' ? t('desktop.resimlerim_count', { count: images.length }) : item.label }))}
            />
          </div>
          <div className="px-5 pb-4 pt-2">
            {tab === 'gallery' && <GalleryTab prefs={prefs} isDark={isDark} onSelect={(id) => store().selectBuiltin(id)} />}
            {tab === 'mine' && (
              <ImagesTab
                prefs={prefs}
                images={images}
                thumbs={thumbs}
                persistent={persistent}
                busy={busy}
                problems={problems}
                onPick={importFiles}
                onSelect={(id) => store().selectImage(id)}
                onRemove={removeImage}
                onDismissProblems={() => setProblems([])}
              />
            )}
            {tab === 'colors' && <ColorsTab prefs={prefs} onSelect={(color) => store().selectSolid(color)} />}
          </div>
        </section>
      </div>

      <footer className="border-t border-border/70 px-5 pb-3 pt-2">
        <div className="flex min-h-6 items-center gap-2 text-[11px]" role="status" aria-live="polite">
          {status && (
            <>
              <span className="min-w-0 truncate text-muted-foreground">{status.text}</span>
              {status.undo && <Button size="2xs" variant="ghost" onClick={status.undo} startIcon={<Undo2 className="size-3" />}>{t('desktop.geri_al')}</Button>}
            </>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={isDefault} onClick={() => store().reset()} startIcon={<RotateCcw className="size-3.5" />}>{t('desktop.varsayilana_don')}</Button>
            {changed && <Button size="sm" variant="ghost" onClick={() => store().restore(snapshot)} startIcon={<Undo2 className="size-3.5" />}>{t('desktop.degisiklikleri_geri_al')}</Button>}
          </div>
          <Button size="sm" onClick={onClose}>{t('desktop.bitti')}</Button>
        </div>
      </footer>

      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-[2px]" role="presentation">
          <span className="flex items-center gap-2 rounded-full bg-popover px-4 py-2 text-xs font-semibold shadow-lg"><Upload className="size-4 text-primary" aria-hidden="true" />{t('desktop.birakin_kapak_resmi_olarak_eklensin')}</span>
        </div>
      )}
    </div>
  );
}

/** @param {{ open: boolean, onClose: () => void }} props */
export default function WallpaperDialog({ open, onClose }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      label={t('desktop.arka_plan')}
      overlayClassName="bg-black/15 backdrop-blur-none"
      className="relative flex h-[min(88vh,720px)] max-w-4xl flex-col overflow-hidden"
    >
      {/* Gövde yalnız açıkken kurulur: sekme/uyarı/durum her açılışta temiz başlar; çıkış animasyonunda eski gövde kalır. */}
      {open && <WallpaperBody onClose={onClose} />}
    </Dialog>
  );
}
