// OpenDeX Ayarları'nın saf modeli (React bilmez, birim testlidir): bölümler, ayar kayıt defteri (arama dizini),
// seçenek listeleri, hazır profiller, öneriler ve yerleşim kararı.
//
// Tasarım ilkesi — "kullanıcının niyeti": ayarlar teknik adlarına göre değil ne için kullanıldığına göre gruplanır
// (Görüntü, Yayın, Ses, Pencereler & Geçiş, Görünüm, Güç & Cihaz…). Her ayar TEK yerde tanımlanır (`SETTING_ITEMS`):
// başlık/açıklama arayüzde de aramada da aynı kaynaktan gelir, bu yüzden arama asla gerçek ekrandan sapmaz.

import { FIT_MODES } from '../window/fitModes.js';

// ───────────────────────────────────────────────────────────────────────────────────────── Bölümler

/** Sol menü sırası. `label` boş = grup başlığı gösterilmez. */
export const SECTION_GROUPS = [
  { id: 'start', label: '', sections: ['overview'] },
  { id: 'experience', label: 'Deneyim', sections: ['display', 'stream', 'audio', 'windows', 'appearance'] },
  { id: 'device', label: 'Cihaz & Sistem', sections: ['power', 'advanced', 'about'] },
];

export const SECTIONS = {
  overview: { id: 'overview', label: 'Genel Bakış', subtitle: 'Durum, hazır profiller ve öneriler' },
  display: { id: 'display', label: 'Görüntü', subtitle: 'Netlik, yoğunluk ve ekran sığdırma' },
  stream: { id: 'stream', label: 'Yayın', subtitle: 'Kodlayıcı, kare hızı ve bant genişliği' },
  audio: { id: 'audio', label: 'Ses', subtitle: 'Yönlendirme ve ses kodlayıcı' },
  windows: { id: 'windows', label: 'Pencereler & Geçiş', subtitle: 'Pencere davranışı ve telefon ⟷ PC geçişi' },
  appearance: { id: 'appearance', label: 'Görünüm', subtitle: 'Tema ve arka plan' },
  power: { id: 'power', label: 'Güç & Cihaz', subtitle: 'Pil tasarrufu ve cihaz hafızası' },
  advanced: { id: 'advanced', label: 'Gelişmiş & Teşhis', subtitle: 'Günlükler, kapasite testi ve sistem bilgisi' },
  about: { id: 'about', label: 'Hakkında', subtitle: 'Mimari ilkeler ve platform sınırları' },
};

export const SECTION_ORDER = SECTION_GROUPS.flatMap((group) => group.sections);
export const DEFAULT_SECTION = 'overview';
export const isSection = (id) => Object.prototype.hasOwnProperty.call(SECTIONS, id);

// ───────────────────────────────────────────────────────────────────────────────────────── Ayar kayıt defteri

/**
 * id → { section, title, description, keywords }. Arama başlık > anahtar sözcük > açıklama sırasıyla puanlar.
 * `description` tek cümlelik özet; uzun teknik ayrıntı ilgili bölümde "Ayrıntılar" altında durur.
 */
export const SETTING_ITEMS = {
  realResolution: {
    section: 'display',
    title: 'Yeniden boyutlandırmada gerçek çözünürlük iste',
    description: 'Daha keskin görüntü; boyut değişiminde kısa bir donma olabilir. Zayıf cihazlarda kapalı tutulabilir.',
    keywords: ['keskin', 'netlik', 'dinamik', 'boyutlandır', 'resize', 'donma'],
  },
  instantResize: {
    section: 'display',
    title: 'Anında Boyutlandır',
    description: 'Pencere bırakıldığı an yeni boyuta geçer; yeni görüntü gelene kadar eski görüntü ölçeklenmiş görünür.',
    keywords: ['resize', 'hızlı', 'gecikme'],
  },
  resolutionMode: {
    section: 'display',
    title: 'Çözünürlük ve Görünüm Stratejisi',
    description: 'Pencerenize uygulanacak çözünürlük, ekran oranı ve dikey içerik yoğunluğunu seçin.',
    keywords: ['çözünürlük', '1080p', '2k', 'tablet', 'dinamik', 'fix', 'zoom', 'oran'],
  },
  customDpi: {
    section: 'display',
    title: 'Özel DPI / İçerik Yoğunluğu',
    description: 'Ekrandaki metin, ikon ve içerik boyutunu sabit bir DPI ile belirleyin (Target DP yerine).',
    keywords: ['dpi', 'yoğunluk', 'metin boyutu', 'ölçek', 'büyük yazı', 'erişilebilirlik'],
  },
  targetDp: {
    section: 'display',
    title: 'Mantıksal DP Alan Pazarlığı (Target DP)',
    description: 'Android\'e iletilen mantıksal çalışma alanını (dp) belirleyin: tablet, masaüstü ya da geniş düzen.',
    keywords: ['dp', 'target', 'sw600', 'tablet düzeni', 'çalışma alanı', 'smallest width'],
  },
  fitMode: {
    section: 'display',
    title: 'Görüntü Sığdırma',
    description: 'Görüntü pencereye nasıl oturur: kenardan kenara, oranı koruyarak ya da kırparak.',
    keywords: ['fit', 'kaplama', 'siyah çubuk', 'letterbox', 'kırp', 'uzat', 'canvas'],
  },
  sharpen: {
    section: 'display',
    title: 'Doku & Kenar Keskinleştirme',
    description: 'Metin ve simge kenarlarındaki cıvıklığı gideren GPU filtresi.',
    keywords: ['sharpening', 'shader', 'lanczos', 'cas', 'netlik', 'bulanık'],
  },
  pixelPerfect: {
    section: 'display',
    title: 'Fiziksel 1:1 Subpixel Eşleme (Pixel‑Perfect DPR)',
    description: 'Windows %125 ölçekleme bulanıklığını önler; telefon piksellerini monitörün fiziksel ızgarasına kilitler.',
    keywords: ['dpr', 'subpixel', 'bulanık', 'windows ölçekleme', 'pixel perfect'],
  },
  codec: {
    section: 'stream',
    title: 'Video Kodlama & Sıkıştırma Motoru',
    description: 'Görüntü netliğini belirleyen donanım kodlayıcı. H.265 (HEVC) metin kenarlarını belirgin korur.',
    keywords: ['h265', 'hevc', 'h264', 'av1', 'kodek', 'encoder', 'sıkıştırma'],
  },
  fps: {
    section: 'stream',
    title: 'Maksimum FPS',
    description: 'Ekran tazeleme ve kare hızı: yüksek değer akıcı, düşük değer tasarruflu.',
    keywords: ['kare hızı', 'akıcılık', 'fps', '60', '30', 'pil'],
  },
  bitrate: {
    section: 'stream',
    title: 'Video Bit Hızı',
    description: 'Görüntü netliğini ve bant genişliğini ayarlar. 2K/4K modlarda yüksek değer önerilir.',
    keywords: ['mbps', 'bant genişliği', 'kalite', 'bitrate', 'ağ'],
  },
  windowLimit: {
    section: 'stream',
    title: 'Maksimum Canlı Pencere / Enkoder Sınırı',
    description: 'Aynı anda canlı video yayını yapacak en çok pencere sayısı.',
    keywords: ['encoder', 'enkoder', 'pencere sayısı', 'limit', 'kapasite'],
  },
  audioRoute: {
    section: 'audio',
    title: 'Ses Çıkışı',
    description: 'Android seslerinin nereye gideceği. Uygulama başına Medya Merkezi ya da mikserden değiştirilebilir.',
    keywords: ['hoparlör', 'telefon', 'dex', 'ikisi', 'yönlendirme', 'kulaklık', 'ses'],
  },
  audioSync: {
    section: 'audio',
    title: 'Telefon–DeX ince ayarı',
    description: '«İkisi» rotasında telefon ve DeX sesini kulakla hizalayın.',
    keywords: ['senkron', 'gecikme', 'hizalama', 'ince ayar', 'eko', 'sync'],
  },
  audioCodec: {
    section: 'audio',
    title: 'Ses Kodlayıcı (Audio Codec)',
    description: 'Ses iletimi için kodlayıcı: ham PCM sıfır gecikme, Opus düşük veri.',
    keywords: ['pcm', 'opus', 'codec', 'gecikme'],
  },
  windowingMode: {
    section: 'windows',
    title: 'Varsayılan Pencereleme Davranışı',
    description: 'Yeni bir pencerenin nerede doğacağı: paylaşımlı Eko alan, bağımsız ekranlar ya da otomatik.',
    keywords: ['eko', 'çalışma alanı', 'workspace', 'bağımsız', 'hibrit', 'vd', 'sanal ekran'],
  },
  handoffWindowing: {
    section: 'windows',
    title: 'Telefona Aktarma Kipi',
    description: 'Telefona aktarılan uygulama tam ekran mı yoksa HyperOS serbest penceresinde mi açılsın.',
    keywords: ['freeform', 'serbest pencere', 'tam ekran', 'aktar', 'handoff', 'hyperos'],
  },
  appClosed: {
    section: 'windows',
    title: 'Uygulama Telefonda Kapatılınca',
    description: 'Telefondan kapatılan uygulamanın penceresi kapansın ya da "Yeniden aç" kartı göstersin.',
    keywords: ['son kullanılanlar', 'kapat', 'yeniden aç', 'rozet'],
  },
  headerHover: {
    section: 'windows',
    title: 'Sürükleyici Başlık (varsayılan)',
    description: '«Genele uy» pencerelerde başlık çubuğu fare üst şeride gelince açılır.',
    keywords: ['başlık çubuğu', 'hover', 'gizli başlık', 'titlebar'],
  },
  dpLock: {
    section: 'windows',
    title: 'Varsayılan Flex DP Kilidi',
    description: 'Boyutlandırmada DPI\'ı sabit tutar (sıfır donma).',
    keywords: ['kilit', 'flex', 'dp', 'sabit yoğunluk', 'resize'],
  },
  stealth: {
    section: 'windows',
    title: 'Stealth DP: Telefonda Açık Uygulamayı DeX\'te Açarken',
    description: 'Telefonda çalışan uygulama DeX\'te açılırken geçiş kaplamanın arkasında, sessizce uyarlanır.',
    keywords: ['stealth', 'sanal ekran', 'dpi geçişi', 'kaplama'],
  },
  handoffPrelanding: {
    section: 'windows',
    title: 'Telefona Aktarırken Ön-İniş',
    description: 'Boyut ve DPI değişimi telefonda değil, PC penceresinin perdesi arkasında yaşanır.',
    keywords: ['ön iniş', 'prelanding', 'aktar', 'geçiş', 'yanlış yerleşim'],
  },
  densityRefresh: {
    section: 'windows',
    title: 'DPI Sonrası Uygulamayı Yenile',
    description: 'DPI değişen uygulamanın arayüzünü yeni yoğunlukta durumu koruyarak yeniden kurdurur.',
    keywords: ['yenile', 'youtube', 'yoğunluk', 'density', 'yeniden kur'],
  },
  densityRefreshHard: {
    section: 'windows',
    title: 'Sert Yenileme (Süreci Yeniden Başlat)',
    description: 'Yalnızca nazik yenileme yetmiyorsa: uygulama süreci yeniden başlatılır.',
    keywords: ['süreç', 'restart', 'zorla', 'arka plan servisi'],
  },
  theme: {
    section: 'appearance',
    title: 'Masaüstü Görünüm Teması',
    description: 'Arayüzün genel temasını seçin: açık ya da karanlık.',
    keywords: ['tema', 'karanlık', 'koyu', 'açık', 'dark', 'light', 'gece'],
  },
  ambient: {
    section: 'appearance',
    title: 'Sinematik Arka Plan (Ambient Backdrop)',
    description: 'Sığdır modunda kenarlardaki siyah çubuklar yerine yumuşak bulanık bir arka plan yansıtır.',
    keywords: ['arka plan', 'siyah çubuk', 'glass', 'bulanık', 'ambient'],
  },
  dimPhone: {
    section: 'power',
    title: 'Kullanırken telefon ekranını karart',
    description: 'Görüntü kalitesini ve yayını etkilemeden telefonda gerçek pil tasarrufu sağlar.',
    keywords: ['pil', 'ekran kapat', 'karart', 'uyku', 'tasarruf', 'ısı'],
  },
  rememberDevices: {
    section: 'power',
    title: 'Bu bilgisayarda cihazları hatırla',
    description: 'Bağlanan cihazlar Kayıtlı Cihazlar listesine eklenir ve tek tıkla yeniden bağlanır.',
    keywords: ['kayıtlı cihaz', 'paylaşılan bilgisayar', 'gizlilik', 'tek tık', 'bağlan'],
  },
  inspector: {
    section: 'advanced',
    title: 'Öğeyi Denetle & XML Inspector Katmanı',
    description: 'Deneysel: ekrandaki metin ve buton koordinatlarını şeffaf bir DOM katmanı olarak yansıtır.',
    keywords: ['inspector', 'uiautomator', 'xml', 'dom', 'geliştirici', 'beta'],
  },
  logs: {
    section: 'advanced',
    title: 'Tanılama Günlüğü',
    description: 'Sorunu yeniden ürettikten hemen sonra günlükleri tek parça panoya kopyalayın.',
    keywords: ['log', 'günlük', 'hata', 'destek', 'pano', 'kopyala', 'rapor'],
  },
  trace: {
    section: 'advanced',
    title: 'Ayrıntılı izleme',
    description: 'Seçilen akışların ayrıntılı kayıtlarını tarayıcı konsoluna ve backend terminaline açar.',
    keywords: ['trace', 'izleme', 'konsol', 'debug', 'handoff', 'video'],
  },
  encoderTest: {
    section: 'advanced',
    title: 'Encoder Kapasite Testi',
    description: 'Cihazın aynı anda kaç pencere yayınlayabildiğini gerçek cihazda ölçer.',
    keywords: ['kapasite', 'stres', 'test', 'pencere sayısı', 'encoder'],
  },
  systemInfo: {
    section: 'advanced',
    title: 'Sistem Bilgisi',
    description: 'Sürüm, çekirdek bileşenler ve doğrulanmış sınırlar.',
    keywords: ['sürüm', 'scrcpy', 'versiyon', 'engine', 'protokol'],
  },
  architecture: {
    section: 'about',
    title: 'Açık Kaynak Sistem Mimarisi',
    description: 'Sıfır kurulum (Zero‑APK): telefona yabancı APK kurulmaz, root gerekmez.',
    keywords: ['zero apk', 'root', 'knox', 'garanti', 'adb', 'gizlilik', 'açık kaynak'],
  },
  directReply: {
    section: 'about',
    title: 'Bildirimlerden Doğrudan Yanıt Neden Yapılamaz?',
    description: 'Android güvenlik bariyeri (PendingIntent & RemoteInput) ve OpenDeX\'in doğal çözümü.',
    keywords: ['bildirim', 'yanıt', 'whatsapp', 'remoteinput', 'reply', 'telegram'],
  },
};

export const settingItem = (id) => SETTING_ITEMS[id];

// ───────────────────────────────────────────────────────────────────────────────────────── Arama

const FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

/** Küçük harf + Türkçe aksan katlama: "cozunurluk" ⇢ "çözünürlük", "ISIK" ⇢ "ışık" ile de eşleşir. */
export function fold(text) {
  return String(text ?? '')
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşüâîû]/g, (ch) => FOLD[ch] || ch)
    .replace(/i̇/g, 'i')
    .trim();
}

/**
 * Ayarlarda arama. Her sözcük başlık/anahtar/açıklama/bölüm adında geçmelidir (VE); başlık eşleşmesi en yüksek puan.
 * Boş sorgu boş liste döner. En çok `limit` sonuç.
 */
export function searchSettings(query, { limit = 12, items = SETTING_ITEMS } = {}) {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const results = [];
  for (const [id, item] of Object.entries(items)) {
    const title = fold(item.title);
    const keywords = fold((item.keywords || []).join(' '));
    const description = fold(item.description);
    const section = fold(SECTIONS[item.section]?.label || '');
    let score = 0;
    let all = true;
    for (const token of tokens) {
      let best = 0;
      if (title.startsWith(token)) best = 12;
      else if (title.split(/[\s/&().:'’‑-]+/).some((word) => word.startsWith(token))) best = 9;
      else if (title.includes(token)) best = 6;
      else if (keywords.includes(token)) best = 5;
      else if (section.includes(token)) best = 3;
      else if (description.includes(token)) best = 2;
      if (!best) {
        all = false;
        break;
      }
      score += best;
    }
    if (all) results.push({ id, section: item.section, title: item.title, description: item.description, score });
  }
  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'tr'));
  return results.slice(0, limit);
}

// ───────────────────────────────────────────────────────────────────────────────────────── Seçenekler

export const RESOLUTION_OPTIONS = [
  { value: 'dynamic', label: 'Dinamik', description: 'Pencerenin o anki boyutuna otomatik uyar. Ek ayar gerektirmez.', tag: 'Otomatik Esnek' },
  { value: 'phone_scale', label: 'Telefon ölçeği (Zoom)', description: 'Uygulamalar telefondaki düzenle açılır; pencereyi büyütmek yakınlaştırır.', tag: 'Telefon Düzeni' },
  { value: 'dynamic_fix', label: 'Dinamik‑Fix (Tam Oturtma)', description: 'Video alanının oranını birebir izler: siyah çubuk ve esneme kalmaz.', tag: 'Tam Oran' },
  { value: '1080p', label: 'Sabit 1080p Standart', description: '16:9 geniş ekran standart masaüstü görünümü.', tag: '1920×1080' },
  { value: 'tablet', label: 'Tablet Modu', description: 'Dikey alanı yüksek: tek ekranda daha çok metin, kod ve web içeriği.', tag: '1920×1200' },
  { value: '2k', label: 'Sabit 2K Masaüstü', description: 'Geniş ve 2K monitörler için yüksek piksel netliği.', tag: '2560×1440' },
  { value: '2.5k', label: '2.5K Tablet', description: 'En yüksek dikey alan: doküman okuma ve uzun sayfalar için.', tag: '2560×1600' },
];

export const DPI_OPTIONS = [
  { value: 'auto', label: 'Otomatik', description: 'Pencere boyutuna göre ergonomik ölçekleme.', tag: 'Önerilen' },
  { value: '180', label: '180 DPI', description: 'Geniş çalışma alanı, çok sütunlu masaüstü düzeni.', tag: 'Masaüstü' },
  { value: '200', label: '200 DPI', description: 'Gözü yormayan altın oran; çoğu 1080p panel için ideal.', tag: 'Optimum' },
  { value: '220', label: '220 DPI', description: 'Dengeli yazı boyutu, tablet görünümü.', tag: 'Kompakt' },
  { value: '240', label: '240 DPI', description: 'Geniş dokunmatik hedefler ve büyük metinler.', tag: 'Büyük Metin' },
  { value: '320', label: '320 DPI', description: 'En büyük simge ve metinler, üst düzey okunabilirlik.', tag: 'Erişilebilirlik' },
];

export const TARGET_DP_OPTIONS = [
  { value: 'auto', label: 'Otomatik', description: 'Pencere boyutuna göre dinamik, ergonomik çalışma alanı.', tag: 'Önerilen' },
  { value: '600', label: '600 dp', description: 'Tablet düzeni: iki sütunlu (master‑detail) arayüzleri açar.', tag: 'Tablet' },
  { value: '720', label: '720 dp', description: 'Standart masaüstü: çok sütunlu DeX tarzı arayüz.', tag: 'Masaüstü' },
  { value: '840', label: '840 dp', description: 'Geniş ekranlarda üretkenlik ve okunabilirlik dengesi.', tag: 'Geniş' },
  { value: '960', label: '960 dp', description: '16:10 dikey alan ve maksimum içerik görünürlüğü.', tag: 'Yoğun' },
];

export const CODEC_OPTIONS = [
  { value: 'auto', label: 'Otomatik', description: 'Cihazın donanımına göre en iyi kodlayıcıyı seçer (H.265 tercihli).', tag: 'Önerilen' },
  { value: 'h265', label: 'H.265 (HEVC)', description: 'Daha keskin metin, daha az renk kanaması, aynı bit hızında yüksek kalite.', tag: 'Maksimum Netlik' },
  { value: 'av1', label: 'AV1', description: 'Yeni nesil, ultra verimli. Yalnızca destekleyen işlemcilerde çalışır.', tag: 'Yeni Nesil' },
  { value: 'h264', label: 'H.264', description: 'Eski donanımlar için evrensel uyumluluk.', tag: 'Uyumlu' },
];

export const SHARPEN_OPTIONS = [
  { value: 'smart', label: 'Akıllı', description: 'Gözü yormadan doğal ve temiz kenar netliği.', tag: 'Önerilen' },
  { value: 'ultra', label: 'Ultra Keskin', description: 'Yüksek kontrastlı, kristal harfler (Lanczos/CAS).', tag: 'Ultra' },
  { value: 'off', label: 'Kapalı', description: 'Filtresiz düz çizim.', tag: 'Standart' },
];

export const FPS_OPTIONS = [
  { value: '15', label: '15 FPS', description: 'Düşük veri kullanımı.', tag: 'Tasarruf' },
  { value: '30', label: '30 FPS', description: 'Standart akıcılık.', tag: 'Dengeli' },
  { value: '60', label: '60 FPS', description: 'Maksimum akıcılık.', tag: 'Önerilen' },
];

export const BITRATE_OPTIONS = [
  { value: '2', label: '2 Mbps', description: 'Zayıf ağ için.', tag: 'Düşük' },
  { value: '4', label: '4 Mbps', description: 'Orta kalite.', tag: 'Dengeli' },
  { value: '8', label: '8 Mbps', description: 'Kristal netlik.', tag: 'Varsayılan' },
  { value: '12', label: '12 Mbps', description: 'Ultra HD.', tag: 'Yüksek' },
  { value: '16', label: '16 Mbps', description: '2K netlik için önerilir.', tag: '2K' },
  { value: '20', label: '20 Mbps', description: 'En yüksek kalite.', tag: 'Maksimum' },
];

export const WINDOW_LIMIT_OPTIONS = [
  { value: 'auto', label: 'Otomatik', description: 'Cihazın test edilmiş donanım sınırını kullanır.', tag: 'Donanım Sınırı' },
  { value: '2', label: '2 Pencere', description: 'Yan yana iki canlı pencere.', tag: '2 Aktif' },
  { value: '3', label: '3 Pencere', description: 'Dengeli kaynak kullanımı.', tag: '3 Aktif' },
  { value: '4', label: '4 Pencere', description: 'Çoklu görev için ideal.', tag: '4 Aktif' },
  { value: '6', label: '6 Pencere', description: 'Yüksek performanslı cihazlar.', tag: '6 Aktif' },
  { value: '16', label: '16 Pencere', description: 'Maksimum donanım kapasitesi.', tag: 'Maks. 16' },
];

export const FIT_OPTIONS = [
  { value: 'fill', label: FIT_MODES.fill.label, description: 'Pencereyi kenardan kenara doldurur; siyah boşluk kalmaz.', tag: 'Önerilen' },
  { value: 'contain', label: FIT_MODES.fit.label, description: 'Oranı korur, uzatmaz; yanlarda siyah çubuk kalabilir.', tag: 'Sıfır Esneme' },
  { value: 'cover', label: FIT_MODES.cover.label, description: 'Uzatmadan yakınlaşır; kenardaki butonlar taşabilir.', tag: 'Zoom / Kırpma' },
];

export const AUDIO_CODEC_OPTIONS = [
  { value: 'pcm', label: 'Ham PCM', description: 'Sıfır gecikmeli, doğrudan işlenebilir ham ses akışı.', tag: 'Sıfır Gecikme' },
  { value: 'opus', label: 'Opus', description: 'Düşük bant genişliği kullanan sıkıştırılmış ses akışı.', tag: 'Düşük Veri' },
];

export const AUDIO_ROUTE_TEXT = {
  phone: { description: 'Sesler telefonun hoparlöründen ya da bağlı kulaklıktan çalar.', tag: 'Telefonda çal' },
  pc: { description: 'Android sesleri bilgisayara (DeX) aktarılır; telefon sessiz kalır.', tag: 'Önerilen' },
  both: { description: 'Sesler aynı anda hem telefondan hem DeX\'ten çalar; iki çıkış aynı ana hizalanır.', tag: 'Eşzamanlı' },
};

export const THEME_OPTIONS = [
  { value: 'light', label: 'Açık', description: 'Temiz gri‑beyaz yüzeyler, yüksek okunabilirlik.', tag: 'Varsayılan' },
  { value: 'dark', label: 'Karanlık', description: 'Derin gece tonları ve cam efekti; gözü yormaz.', tag: 'Gece' },
];

export const WINDOWING_MODE_OPTIONS = [
  { value: 'eco', label: 'Eko Çalışma Alanı', description: 'Paylaşımlı tek encoder: en düşük ısı ve pil.', tag: '1 encoder' },
  { value: 'independent', label: 'Bağımsız Ekranlar', description: 'Her pencere kendi sanal ekranında: en yüksek uyumluluk.', tag: 'Pencere başına VD' },
  { value: 'hybrid', label: 'Hibrit (Otomatik)', description: 'Cihaz kapasitesine göre otomatik seçer.', tag: 'Önerilen' },
];

export const HANDOFF_OPTIONS = [
  { value: 'fullscreen', label: 'Tam ekran', description: 'Uygulama telefonun ekranını tamamen kaplar.', tag: 'Önerilen' },
  { value: 'freeform', label: 'Serbest pencere', description: 'HyperOS\'un kendi küçük penceresi; taşınabilir ve yeniden boyutlanabilir.', tag: 'Küçük pencere' },
];

export const APP_CLOSED_OPTIONS = [
  { value: 'close', label: 'Pencereyi kapat', description: 'Telefondan kapatılan uygulamanın penceresi de kapanır.', tag: 'Varsayılan' },
  { value: 'badge', label: 'Pencerede göster', description: 'Pencere kalır; üstünde «Yeniden aç / Kapat» kartı çıkar.', tag: 'Yeniden aç' },
];

// ───────────────────────────────────────────────────────────────────────────────────────── Değer okumaları

const labelOf = (options, value) => options.find((option) => option.value === value)?.label ?? '';

const DEFAULTS = {
  dynamic_resolution_enabled: false,
  resolution_mode: 'dynamic',
  video_codec: 'auto',
  max_fps: 60,
  video_bit_rate: 8_000_000,
  sharpening_mode: 'adaptive',
  screen_off_while_mirroring: false,
  audio_output_mode: 'pc',
  windowing_mode: 'hybrid_auto',
  phone_handoff_windowing: 'fullscreen',
  density_refresh_hard: false,
  audio_sync_offset_ms: 0,
};

/** `live` (canlı ayar, eksik olabilir) → anahtar için değer; yoksa backend varsayılanı. */
export const settingValue = (live, key) => (live && live[key] !== undefined ? live[key] : DEFAULTS[key]);

/** Genel Bakış ve dar ekran listesi için bir bölümün tek satırlık özeti. */
export function sectionSummary(sectionId, live) {
  const get = (key) => settingValue(live, key);
  switch (sectionId) {
    case 'display': {
      const dpi = Number(get('custom_dpi')) > 0 ? `${get('custom_dpi')} DPI` : Number(get('target_dp')) > 0 ? `${get('target_dp')} dp` : 'Oto yoğunluk';
      return `${labelOf(RESOLUTION_OPTIONS, get('resolution_mode')) || 'Dinamik'} · ${dpi}`;
    }
    case 'stream': {
      const codec = { auto: 'Oto', h265: 'H.265', h264: 'H.264', av1: 'AV1' }[get('video_codec')] || 'Oto';
      return `${codec} · ${get('max_fps')} FPS · ${Math.round(get('video_bit_rate') / 1_000_000)} Mbps`;
    }
    case 'audio':
      return { pc: 'DeX', phone: 'Telefon', both: 'İkisi' }[get('audio_output_mode')] || 'DeX';
    case 'windows': {
      const mode = { eco: 'Eko', independent: 'Bağımsız', hybrid_auto: 'Hibrit' }[get('windowing_mode')] || 'Hibrit';
      return `${mode} · ${get('phone_handoff_windowing') === 'freeform' ? 'Serbest aktarım' : 'Tam ekran aktarım'}`;
    }
    case 'appearance':
      return live?.ambient_backdrop === false ? 'Arka plan kapalı' : 'Sinematik arka plan';
    case 'power':
      return get('screen_off_while_mirroring') ? 'Telefon ekranı kararır' : 'Telefon ekranı açık';
    default:
      return '';
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────── Profiller

/**
 * Tek tıkla uygulanan hazır profiller. Yama TEK atomik kayıt olarak gider; yalnız akışı etkileyen birkaç anahtar değişir
 * (DPI, tema, ses, pencere davranışı gibi kişisel tercihlere dokunulmaz).
 */
export const PROFILES = [
  {
    id: 'balanced',
    label: 'Dengeli',
    tagline: 'Günlük kullanım',
    description: 'Akıcı 60 FPS ve temiz metin; pil ve ısı makul kalır.',
    patch: {
      video_codec: 'auto', max_fps: 60, video_bit_rate: 8_000_000, sharpening_mode: 'adaptive',
      dynamic_resolution_enabled: true, screen_off_while_mirroring: false,
    },
  },
  {
    id: 'clarity',
    label: 'Maksimum Netlik',
    tagline: 'Metin ve tasarım işleri',
    description: 'H.265, 16 Mbps ve ultra keskinlik; en kristal görüntü.',
    patch: {
      video_codec: 'h265', max_fps: 60, video_bit_rate: 16_000_000, sharpening_mode: 'ultra',
      dynamic_resolution_enabled: true, screen_off_while_mirroring: false,
    },
  },
  {
    id: 'battery',
    label: 'Pil & Isı',
    tagline: 'Uzun oturumlar',
    description: '30 FPS, düşük bit hızı ve karartılmış telefon ekranı.',
    patch: {
      video_codec: 'auto', max_fps: 30, video_bit_rate: 4_000_000, sharpening_mode: 'off',
      dynamic_resolution_enabled: false, screen_off_while_mirroring: true,
    },
  },
  {
    id: 'lowdata',
    label: 'Zayıf Ağ',
    tagline: 'Wi‑Fi / mobil bağlantı',
    description: 'H.265 ile 2 Mbps: en düşük bant genişliğinde kullanılabilir görüntü.',
    patch: {
      video_codec: 'h265', max_fps: 30, video_bit_rate: 2_000_000, sharpening_mode: 'adaptive',
      dynamic_resolution_enabled: false, screen_off_while_mirroring: false,
    },
  },
];

const normalizeSharpen = (value) => (value === 'smart' ? 'adaptive' : value);

/** Canlı ayarlar bir profilin TÜM anahtarlarıyla eşleşiyorsa o profilin kimliği; aksi hâlde 'custom'. */
export function activeProfileId(live) {
  if (!live) return 'custom';
  for (const profile of PROFILES) {
    const matches = Object.entries(profile.patch).every(([key, value]) => {
      const current = key === 'sharpening_mode' ? normalizeSharpen(settingValue(live, key)) : settingValue(live, key);
      return current === value;
    });
    if (matches) return profile.id;
  }
  return 'custom';
}

// ───────────────────────────────────────────────────────────────────────────────────────── Öneriler

/**
 * Mevcut ayarlardan çıkan kısa, eyleme dönük öneriler (en çok `limit`). Her biri ya tek tıkla uygulanan bir `patch` ya da
 * bir bölüme gitme (`section`) eylemi taşır; uyarılar (warn) önce gelir.
 */
export function recommendations(live, { limit = 3 } = {}) {
  if (!live) return [];
  const out = [];
  const fps = Number(settingValue(live, 'max_fps'));
  const bitrate = Number(settingValue(live, 'video_bit_rate'));

  if (settingValue(live, 'density_refresh_hard')) {
    out.push({
      id: 'hard-refresh', tone: 'warn', title: 'Sert yenileme açık',
      body: 'DPI değişince uygulamaların süreci yeniden başlatılır; çalan müzik gibi arka plan servisleri kesilir.',
      action: { label: 'Kapat', patch: { density_refresh_hard: false } },
    });
  }
  if (bitrate > 0 && bitrate <= 2_000_000 && fps >= 60) {
    out.push({
      id: 'low-bitrate-high-fps', tone: 'warn', title: 'Düşük bit hızı + 60 FPS',
      body: '2 Mbps\'de 60 kare görüntüde blok ve bulanıklık yaratır. Kare hızını düşürün ya da bit hızını artırın.',
      action: { label: '8 Mbps yap', patch: { video_bit_rate: 8_000_000 } },
    });
  }
  if (!settingValue(live, 'dynamic_resolution_enabled') && ['dynamic', 'dynamic_fit', 'dynamic_fix'].includes(settingValue(live, 'resolution_mode'))) {
    out.push({
      id: 'real-resolution-off', tone: 'info', title: 'Gerçek çözünürlük kapalı',
      body: 'Pencereyi büyüttüğünüzde görüntü yeniden netleşmez, ölçeklenmiş kalır.',
      action: { label: 'Aç', patch: { dynamic_resolution_enabled: true } },
    });
  }
  if (settingValue(live, 'video_codec') === 'h264') {
    out.push({
      id: 'codec-h264', tone: 'info', title: 'H.265 daha keskin metin verir',
      body: 'H.264 yalnızca eski donanımlar içindir; telefonunuz destekliyorsa Otomatik daha net bir görüntü sağlar.',
      action: { label: 'Otomatik yap', patch: { video_codec: 'auto' } },
    });
  }
  if (settingValue(live, 'audio_output_mode') === 'both' && Number(settingValue(live, 'audio_sync_offset_ms')) === 0) {
    out.push({
      id: 'audio-sync', tone: 'info', title: '«İkisi» için ses ince ayarı',
      body: 'Telefon ve DeX sesi arasında yankı duyarsanız kulakla hizalayabilirsiniz.',
      action: { label: 'Ayara git', section: 'audio' },
    });
  }
  const rank = { warn: 0, info: 1 };
  return out.sort((a, b) => rank[a.tone] - rank[b.tone]).slice(0, limit);
}

// ───────────────────────────────────────────────────────────────────────────────────────── Yerleşim

export const NARROW_MAX_PX = 560;
export const RAIL_MAX_PX = 780;

/**
 * Pencere genişliğinden yerleşim: `wide` (etiketli kenar çubuğu, DeX/masaüstü) · `rail` (yalnız ikonlu ray, orta pencere) ·
 * `narrow` (telefon: kategori listesi → ayrıntı sayfası, geri düğmesiyle).
 */
export function layoutForWidth(width) {
  if (!(width > 0)) return 'wide';
  if (width < NARROW_MAX_PX) return 'narrow';
  if (width < RAIL_MAX_PX) return 'rail';
  return 'wide';
}
