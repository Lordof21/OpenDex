// Dosya türleri → ikon, ton (renk token'ı), Türkçe tür adı. TEK doğruluk kaynağı: liste, ızgara, önizleme ve
// özellikler penceresi aynı tabloyu okur; yeni bir uzantı eklemek bu dosyada tek satırdır.
//
// Ton adları tailwind.config.js `ft-*` renklerine ve index.css `--ft-*` token'larına karşılık gelir (açık/koyu tema
// birlikte tanımlı): bileşenlerde ham renk YOK.
import {
  AppWindow,
  Archive,
  BookOpen,
  Camera,
  Cog,
  Database,
  Disc3,
  Download,
  File,
  FileCode2,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Film,
  Folder,
  Image,
  Link2,
  MessageCircle,
  Monitor,
  Music,
  Package,
  Presentation,
  Smartphone,
  Subtitles,
  Trash2,
  Type,
} from 'lucide-react';

/** Tür → { icon, tone, label }. `label` yalnızca uzantı bilinmiyorsa kullanılan genel ad; uzantılı ad typeLabel'dadır. */
export const KIND_META = Object.freeze({
  folder: { icon: Folder, tone: 'folder', label: 'Klasör' },
  image: { icon: FileImage, tone: 'image', label: 'Resim' },
  video: { icon: FileVideo, tone: 'video', label: 'Video' },
  audio: { icon: FileMusic, tone: 'audio', label: 'Ses' },
  pdf: { icon: FileText, tone: 'pdf', label: 'PDF belgesi' },
  doc: { icon: FileText, tone: 'doc', label: 'Belge' },
  sheet: { icon: FileSpreadsheet, tone: 'sheet', label: 'Elektronik tablo' },
  slides: { icon: Presentation, tone: 'slides', label: 'Sunum' },
  text: { icon: FileText, tone: 'generic', label: 'Metin belgesi' },
  archive: { icon: Archive, tone: 'archive', label: 'Arşiv' },
  code: { icon: FileCode2, tone: 'code', label: 'Kaynak kod' },
  data: { icon: Database, tone: 'data', label: 'Veri dosyası' },
  app: { icon: AppWindow, tone: 'app', label: 'Uygulama' },
  apk: { icon: Package, tone: 'app', label: 'Android uygulaması' },
  font: { icon: Type, tone: 'generic', label: 'Yazı tipi' },
  disk: { icon: Disc3, tone: 'archive', label: 'Disk görüntüsü' },
  ebook: { icon: BookOpen, tone: 'doc', label: 'E-kitap' },
  subtitle: { icon: Subtitles, tone: 'generic', label: 'Altyazı' },
  config: { icon: Cog, tone: 'generic', label: 'Yapılandırma' },
  link: { icon: Link2, tone: 'generic', label: 'Bağlantı' },
  unknown: { icon: File, tone: 'generic', label: 'Dosya' },
});

const GROUPS = {
  image: 'jpg jpeg jpe jfif png gif webp bmp ico avif heic heif tif tiff svg raw dng cr2 nef arw psd xcf',
  video: 'mp4 m4v mkv webm avi mov wmv flv 3gp 3g2 mpg mpeg ts m2ts vob ogv',
  audio: 'mp3 m4a aac ogg oga opus wav flac wma aiff aif amr mid midi',
  pdf: 'pdf',
  doc: 'doc docx odt rtf pages wps',
  sheet: 'xls xlsx ods csv tsv numbers',
  slides: 'ppt pptx odp key',
  text: 'txt md markdown log nfo',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst lz cab',
  code: 'js mjs cjs jsx ts tsx py java kt kts c h cpp hpp cc cs go rs rb php swift sh bat cmd ps1 sql html htm css scss less vue lua dart gradle',
  data: 'json xml yaml yml toml db sqlite sqlite3 sql3 dat bin parquet',
  app: 'exe msi com scr dll appx msix dmg pkg deb rpm appimage',
  apk: 'apk apks xapk aab',
  font: 'ttf otf woff woff2 fon',
  disk: 'iso img vhd vhdx vmdk',
  ebook: 'epub mobi azw azw3 fb2 djvu',
  subtitle: 'srt vtt ass ssa sub',
  config: 'ini cfg conf properties env gitignore editorconfig',
  link: 'lnk url desktop webloc',
};

const EXT_TO_KIND = new Map();
for (const [kind, list] of Object.entries(GROUPS)) {
  for (const ext of list.split(' ')) if (!EXT_TO_KIND.has(ext)) EXT_TO_KIND.set(ext, kind);
}

/** Küçük harfli uzantı ('' yok). `.env` → 'env'; `arsiv.tar.gz` → 'gz'. */
export function extensionOf(name) {
  if (typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  return dot < 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function kindOf(entry) {
  if (!entry) return 'unknown';
  if (entry.kind === 'dir') return 'folder';
  return EXT_TO_KIND.get(extensionOf(entry.name)) || 'unknown';
}

/** "JPG Resmi", "ZIP Arşivi", ".xyz dosyası", "Klasör" — Windows Gezgini'ndeki "Tür" sütunu gibi. */
export function typeLabel(entry) {
  if (!entry) return '';
  if (entry.kind === 'dir') return entry.symlink ? 'Klasör bağlantısı' : 'Klasör';
  const ext = extensionOf(entry.name);
  const kind = kindOf(entry);
  if (!ext) return KIND_META[kind].label;
  const upper = ext.toUpperCase(); // teknik simge: Türkçe kuralı (i → İ) 'ZİP' yazdırırdı
  if (kind === 'unknown') return `${upper} dosyası`;
  const noun = { image: 'Resmi', video: 'Videosu', audio: 'Ses dosyası', archive: 'Arşivi', pdf: 'Belgesi', doc: 'Belgesi', sheet: 'Tablosu', slides: 'Sunumu', text: 'Metin belgesi', code: 'Kaynak dosyası', data: 'Veri dosyası', app: 'Uygulaması', apk: 'Paketi', font: 'Yazı tipi', disk: 'Görüntüsü', ebook: 'E-kitabı', subtitle: 'Altyazısı', config: 'Yapılandırma dosyası', link: 'Bağlantısı' }[kind];
  return noun ? `${upper} ${noun}` : upper;
}

/** Sıralama anahtarı: görünen tür adı ("MP3 Ses dosyası"), klasörler ''. Aynı türler yan yana, Gezgin'deki gibi alfabetik. */
export function typeSortKey(entry) {
  return entry.kind === 'dir' ? '' : typeLabel(entry);
}

// ── Özel klasörler: ad (küçük harf, Türkçe yerelleştirilmiş adlar dahil) → simge ──────────────────────────────
const SPECIAL = new Map([
  ['dcim', { glyph: Camera, label: 'Kamera' }],
  ['camera', { glyph: Camera, label: 'Kamera' }],
  ['download', { glyph: Download, label: 'İndirilenler' }],
  ['downloads', { glyph: Download, label: 'İndirilenler' }],
  ['indirilenler', { glyph: Download, label: 'İndirilenler' }],
  ['pictures', { glyph: Image, label: 'Resimler' }],
  ['resimler', { glyph: Image, label: 'Resimler' }],
  ['screenshots', { glyph: Monitor, label: 'Ekran görüntüleri' }],
  ['ekran görüntüleri', { glyph: Monitor, label: 'Ekran görüntüleri' }],
  ['music', { glyph: Music, label: 'Müzik' }],
  ['müzik', { glyph: Music, label: 'Müzik' }],
  ['movies', { glyph: Film, label: 'Filmler' }],
  ['videos', { glyph: Film, label: 'Videolar' }],
  ['videolar', { glyph: Film, label: 'Videolar' }],
  ['documents', { glyph: FileText, label: 'Belgeler' }],
  ['belgeler', { glyph: FileText, label: 'Belgeler' }],
  ['android', { glyph: Smartphone, label: 'Android' }],
  ['whatsapp', { glyph: MessageCircle, label: 'WhatsApp' }],
  ['telegram', { glyph: MessageCircle, label: 'Telegram' }],
  ['.opendex-trash', { glyph: Trash2, label: 'Geri dönüşüm' }],
]);

// Anahtar: varsayılan (yerel-bağımsız) küçük harf + birleşik noktayı at. Türkçe kuralı ('I' → 'ı') 'DCIM'i 'dcım' yapıp
// İngilizce adları kaçırırdı; 'İNDİRİLENLER' bu yolla 'indirilenler' olur.
const folderKey = (name) => name.toLowerCase().replace(/\u0307/g, '');

export function specialFolderGlyph(entry) {
  if (!entry || entry.kind !== 'dir') return null;
  return SPECIAL.get(folderKey(entry.name))?.glyph || null;
}

/** Bir girdinin çizim bilgisi: { Icon, tone, kind, Glyph? }. `Glyph`: büyük (≥40 px) klasör simgesinin içine konan işaret. */
export function iconFor(entry) {
  const kind = kindOf(entry);
  const meta = KIND_META[kind];
  return { Icon: meta.icon, tone: meta.tone, kind, Glyph: specialFolderGlyph(entry) };
}

/** Tailwind sınıfı (tam dize: JIT derlemesi için sabit yazılır). */
export const TONE_CLASS = Object.freeze({
  folder: 'text-ft-folder',
  image: 'text-ft-image',
  video: 'text-ft-video',
  audio: 'text-ft-audio',
  pdf: 'text-ft-pdf',
  doc: 'text-ft-doc',
  sheet: 'text-ft-sheet',
  slides: 'text-ft-slides',
  archive: 'text-ft-archive',
  code: 'text-ft-code',
  data: 'text-ft-data',
  app: 'text-ft-app',
  generic: 'text-ft-generic',
});

// ── Küçük resim / önizleme yetenekleri ─────────────────────────────────────────────────────────────────────────
const PC_THUMB = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'ico', 'avif']);
const PHONE_THUMB_KINDS = new Set(['image', 'video', 'audio']);
const MAX_THUMB_BYTES = 64 * 1024 * 1024;

/** Bu girdi için küçük resim istenebilir mi? (PC: Pillow'un çözebildikleri; telefon: cihazın kendi çözücüsü) */
export function canThumbnail(entry, provider) {
  if (!entry || entry.kind === 'dir' || entry.size > MAX_THUMB_BYTES) return false;
  if (provider === 'phone') return PHONE_THUMB_KINDS.has(kindOf(entry));
  return PC_THUMB.has(extensionOf(entry.name));
}

const PREVIEW_KINDS = new Set(['image', 'video', 'audio', 'text', 'code', 'data', 'config', 'subtitle']);
const PREVIEW_EXTRA = new Set(['svg', 'html', 'htm']); // metin olarak gösterilir (backend de text/plain verir)

/** Belge önizlemesi (PDF, DOCX, XLSX, PPTX) tarayıcı belleğine tam okunur: bundan büyüğü önizlenmez ("Bilgisayarda aç").
 * Backend'in gerçek kapasitesiyle (app/config.py'deki FS_PREVIEW_MAX_MB, varsayılan 96) AYNI kalmalı — daha düşük bir
 * değer burada, backend'in önizleyebileceği bir dosyayı (örn. 70 MB'lık bir PDF) hiç denemeden direkt "bilgisayara
 * indir" yoluna düşürür. */
export const DOC_PREVIEW_MAX_BYTES = 96 * 1024 * 1024;
const DOCUMENT_PREVIEWS = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };

/** Önizleme türü: 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | null (→ "Bilgisayarda aç"). */
export function previewKind(entry) {
  if (!entry || entry.kind === 'dir') return null;
  const ext = extensionOf(entry.name);
  const kind = kindOf(entry);
  if (DOCUMENT_PREVIEWS[ext]) return entry.size > DOC_PREVIEW_MAX_BYTES ? null : DOCUMENT_PREVIEWS[ext];
  if (ext === 'csv' || ext === 'tsv') return entry.size > 1_000_000 ? null : 'text';
  if (kind === 'image') return ext === 'svg' || ['heic', 'heif', 'tif', 'tiff', 'psd', 'raw', 'dng', 'cr2', 'nef', 'arw', 'xcf'].includes(ext) ? (ext === 'svg' ? 'text' : null) : 'image';
  if (kind === 'video') return ['mp4', 'm4v', 'mov', '3gp', '3g2', 'webm', 'ogv'].includes(ext) ? 'video' : null;
  if (kind === 'audio') return ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac'].includes(ext) ? 'audio' : null;
  if (PREVIEW_KINDS.has(kind) || PREVIEW_EXTRA.has(ext)) return entry.size > 1_000_000 ? null : 'text';
  return null;
}

/** Bir klasörün çoğunluğu medya mı? (görünüm "otomatik" iken ızgaraya geçmek için) */
export function looksLikeMediaFolder(entries) {
  const files = entries.filter((e) => e.kind !== 'dir');
  if (files.length < 8) return false;
  let media = 0;
  for (const e of files) {
    const k = kindOf(e);
    if (k === 'image' || k === 'video') media += 1;
  }
  return media / files.length >= 0.6;
}
