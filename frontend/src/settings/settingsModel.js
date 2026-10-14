// OpenDeX Ayarları'nın saf modeli (React bilmez, birim testlidir): bölümler, ayar kayıt defteri (arama dizini),
// seçenek listeleri, hazır profiller, öneriler ve yerleşim kararı.
//
// Tasarım ilkesi — "kullanıcının niyeti": ayarlar teknik adlarına göre değil ne için kullanıldığına göre gruplanır
// (Görüntü, Yayın, Ses, Pencereler & Geçiş, Görünüm, Güç & Cihaz…). Her ayar TEK yerde tanımlanır (`SETTING_ITEMS`):
// başlık/açıklama arayüzde de aramada da aynı kaynaktan gelir, bu yüzden arama asla gerçek ekrandan sapmaz.

import { FIT_MODES } from '../window/fitModes.js';
import { t, activeLocale } from '../i18n/index.js';

// ───────────────────────────────────────────────────────────────────────────────────────── Bölümler

/** Sol menü sırası. `label` boş = grup başlığı gösterilmez. */
export const SECTION_GROUPS = [
  { id: 'start', label: '', sections: ['overview'] },
  { id: 'experience', label: t('settings.deneyim'), sections: ['display', 'stream', 'audio', 'windows', 'appearance'] },
  { id: 'device', label: t('settings.cihaz_sistem'), sections: ['power', 'advanced', 'about'] },
];

export const SECTIONS = {
  overview: { id: 'overview', label: t('settings.genel_bakis'), subtitle: t('settings.durum_hazir_profiller_ve_oneriler') },
  display: { id: 'display', label: t('common.goruntu'), subtitle: t('settings.netlik_yogunluk_ve_ekran_sigdirma') },
  stream: { id: 'stream', label: t('settings.yayin'), subtitle: t('settings.kodlayici_kare_hizi_ve_bant_genisligi') },
  audio: { id: 'audio', label: t('common.ses'), subtitle: t('settings.yonlendirme_ve_ses_kodlayici') },
  windows: { id: 'windows', label: t('settings.pencereler_gecis'), subtitle: t('settings.pencere_davranisi_ve_telefon_pc_gecisi') },
  appearance: { id: 'appearance', label: t('common.gorunum'), subtitle: t('settings.tema_ve_arka_plan') },
  power: { id: 'power', label: t('settings.guc_cihaz'), subtitle: t('settings.pil_tasarrufu_ve_cihaz_hafizasi') },
  advanced: { id: 'advanced', label: t('settings.gelismis_teshis'), subtitle: t('settings.gunlukler_kapasite_testi_ve_sistem') },
  about: { id: 'about', label: t('settings.hakkinda'), subtitle: t('settings.mimari_ilkeler_ve_platform_sinirlari') },
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
    title: t('settings.yeniden_boyutlandirmada_gercek'),
    description: t('settings.daha_keskin_goruntu_boyut_degisiminde'),
    keywords: ['keskin', 'netlik', 'dinamik', t('settings.boyutlandir'), 'resize', 'donma'],
  },
  instantResize: {
    section: 'display',
    title: t('settings.aninda_boyutlandir'),
    description: t('settings.pencere_birakildigi_an_yeni_boyuta'),
    keywords: ['resize', t('settings.hizli'), 'gecikme'],
  },
  resolutionMode: {
    section: 'display',
    title: t('settings.cozunurluk_ve_gorunum_stratejisi'),
    description: t('settings.pencerenize_uygulanacak_cozunurluk'),
    keywords: [t('settings.cozunurluk'), '1080p', '2k', 'tablet', 'dinamik', 'fix', 'zoom', 'oran'],
  },
  customDpi: {
    section: 'display',
    title: t('settings.ozel_dpi_icerik_yogunlugu'),
    description: t('settings.ekrandaki_metin_ikon_ve_icerik'),
    keywords: ['dpi', t('settings.yogunluk'), 'metin boyutu', t('settings.olcek'), t('settings.buyuk_yazi'), t('settings.erisilebilirlik')],
  },
  targetDp: {
    section: 'display',
    title: t('settings.mantiksal_dp_alan_pazarligi_target_dp'),
    description: t('settings.android_e_iletilen_mantiksal_calisma'),
    keywords: ['dp', 'target', 'sw600', t('settings.tablet_duzeni'), t('settings.calisma_alani'), 'smallest width'],
  },
  fitMode: {
    section: 'display',
    title: t('common.goruntu_sigdirma'),
    description: t('settings.goruntu_pencereye_nasil_oturur'),
    keywords: ['fit', 'kaplama', t('settings.siyah_cubuk'), 'letterbox', t('settings.kirp'), 'uzat', 'canvas'],
  },
  sharpen: {
    section: 'display',
    title: t('settings.doku_kenar_keskinlestirme'),
    description: t('settings.metin_ve_simge_kenarlarindaki'),
    keywords: ['sharpening', 'shader', 'lanczos', 'cas', 'netlik', t('settings.bulanik')],
  },
  pixelPerfect: {
    section: 'display',
    title: t('settings.fiziksel_1_1_subpixel_esleme_pixel'),
    description: t('settings.windows_125_olcekleme_bulanikligini'),
    keywords: ['dpr', 'subpixel', t('settings.bulanik'), t('settings.windows_olcekleme'), 'pixel perfect'],
  },
  codec: {
    section: 'stream',
    title: t('settings.video_kodlama_sikistirma_motoru'),
    description: t('settings.goruntu_netligini_belirleyen_donanim'),
    keywords: ['h265', 'hevc', 'h264', 'av1', 'kodek', 'encoder', t('settings.sikistirma')],
  },
  fps: {
    section: 'stream',
    title: t('common.maksimum_fps'),
    description: t('settings.ekran_tazeleme_ve_kare_hizi_yuksek'),
    keywords: [t('settings.kare_hizi'), t('settings.akicilik'), 'fps', '60', '30', 'pil'],
  },
  bitrate: {
    section: 'stream',
    title: t('common.video_bit_hizi'),
    description: t('settings.goruntu_netligini_ve_bant_genisligini'),
    keywords: ['mbps', t('settings.bant_genisligi'), 'kalite', 'bitrate', t('settings.ag')],
  },
  windowLimit: {
    section: 'stream',
    title: t('settings.maksimum_canli_pencere_enkoder_siniri'),
    description: t('settings.ayni_anda_canli_video_yayini_yapacak'),
    keywords: ['encoder', 'enkoder', t('settings.pencere_sayisi'), 'limit', 'kapasite'],
  },
  audioRoute: {
    section: 'audio',
    title: t('common.ses_cikisi'),
    description: t('settings.android_seslerinin_nereye_gidecegi'),
    keywords: [t('settings.hoparlor'), 'telefon', 'dex', 'ikisi', t('settings.yonlendirme'), t('settings.kulaklik'), 'ses'],
  },
  audioSync: {
    section: 'audio',
    title: t('common.telefon_dex_ince_ayari'),
    description: t('settings.ikisi_rotasinda_telefon_ve_dex_sesini'),
    keywords: ['senkron', 'gecikme', 'hizalama', 'ince ayar', 'eko', 'sync'],
  },
  audioCodec: {
    section: 'audio',
    title: t('settings.ses_kodlayici_audio_codec'),
    description: t('settings.ses_iletimi_icin_kodlayici_ham_pcm'),
    keywords: ['pcm', 'opus', 'codec', 'gecikme'],
  },
  windowingMode: {
    section: 'windows',
    title: t('common.varsayilan_pencereleme_davranisi'),
    description: t('settings.yeni_bir_pencerenin_nerede_dogacagi'),
    keywords: ['eko', t('settings.calisma_alani'), 'workspace', t('settings.bagimsiz'), 'hibrit', 'vd', 'sanal ekran'],
  },
  handoffWindowing: {
    section: 'windows',
    title: t('common.telefona_aktarma_kipi'),
    description: t('settings.telefona_aktarilan_uygulama_tam_ekran'),
    keywords: ['freeform', 'serbest pencere', 'tam ekran', 'aktar', 'handoff', 'hyperos'],
  },
  appClosed: {
    section: 'windows',
    title: t('common.uygulama_telefonda_kapatilinca'),
    description: t('settings.telefondan_kapatilan_uygulamanin_2'),
    keywords: [t('settings.son_kullanilanlar'), 'kapat', t('settings.yeniden_ac'), 'rozet'],
  },
  headerHover: {
    section: 'windows',
    title: t('common.surukleyici_baslik_varsayilan'),
    description: t('settings.genele_uy_pencerelerde_baslik_cubugu'),
    keywords: [t('settings.baslik_cubugu'), 'hover', t('settings.gizli_baslik'), 'titlebar'],
  },
  dpLock: {
    section: 'windows',
    title: t('common.varsayilan_flex_dp_kilidi'),
    description: t('settings.boyutlandirmada_dpi_i_sabit_tutar'),
    keywords: ['kilit', 'flex', 'dp', t('settings.sabit_yogunluk'), 'resize'],
  },
  stealth: {
    section: 'windows',
    title: t('settings.stealth_dp_telefonda_acik_uygulamayi'),
    description: t('settings.telefonda_calisan_uygulama_dex_te'),
    keywords: ['stealth', 'sanal ekran', t('settings.dpi_gecisi'), 'kaplama'],
  },
  handoffPrelanding: {
    section: 'windows',
    title: t('settings.telefona_aktarirken_on_inis'),
    description: t('settings.boyut_ve_dpi_degisimi_telefonda_degil'),
    keywords: [t('settings.on_inis'), 'prelanding', 'aktar', t('settings.gecis'), t('settings.yanlis_yerlesim')],
  },
  densityRefresh: {
    section: 'windows',
    title: t('settings.dpi_sonrasi_uygulamayi_yenile'),
    description: t('settings.dpi_degisen_uygulamanin_arayuzunu'),
    keywords: ['yenile', 'youtube', t('settings.yogunluk'), 'density', 'yeniden kur'],
  },
  densityRefreshHard: {
    section: 'windows',
    title: t('settings.sert_yenileme_sureci_yeniden_baslat'),
    description: t('settings.yalnizca_nazik_yenileme_yetmiyorsa_2'),
    keywords: [t('settings.surec'), 'restart', 'zorla', 'arka plan servisi'],
  },
  theme: {
    section: 'appearance',
    title: t('settings.masaustu_gorunum_temasi'),
    description: t('settings.arayuzun_genel_temasini_secin_acik_ya'),
    keywords: ['tema', t('settings.karanlik'), 'koyu', t('common.acik'), 'dark', 'light', 'gece'],
  },
  ambient: {
    section: 'appearance',
    title: t('settings.sinematik_arka_plan_ambient_backdrop'),
    description: t('settings.sigdir_modunda_kenarlardaki_siyah'),
    keywords: ['arka plan', t('settings.siyah_cubuk'), 'glass', t('settings.bulanik'), 'ambient'],
  },
  dimPhone: {
    section: 'power',
    title: t('settings.kullanirken_telefon_ekranini_karart'),
    description: t('settings.goruntu_kalitesini_ve_yayini'),
    keywords: ['pil', 'ekran kapat', 'karart', 'uyku', 'tasarruf', t('settings.isi')],
  },
  rememberDevices: {
    section: 'power',
    title: t('settings.bu_bilgisayarda_cihazlari_hatirla'),
    description: t('settings.baglanan_cihazlar_kayitli_cihazlar'),
    keywords: [t('settings.kayitli_cihaz'), t('settings.paylasilan_bilgisayar'), 'gizlilik', t('settings.tek_tik'), t('settings.baglan')],
  },
  inspector: {
    section: 'advanced',
    title: t('settings.ogeyi_denetle_xml_inspector_katmani'),
    description: t('settings.deneysel_ekrandaki_metin_ve_buton'),
    keywords: ['inspector', 'uiautomator', 'xml', 'dom', t('settings.gelistirici'), 'beta'],
  },
  logs: {
    section: 'advanced',
    title: t('settings.tanilama_gunlugu'),
    description: t('settings.sorunu_yeniden_urettikten_hemen_sonra'),
    keywords: ['log', t('settings.gunluk'), 'hata', 'destek', 'pano', 'kopyala', 'rapor'],
  },
  trace: {
    section: 'advanced',
    title: t('settings.ayrintili_izleme'),
    description: t('settings.secilen_akislarin_ayrintili'),
    keywords: ['trace', 'izleme', 'konsol', 'debug', 'handoff', 'video'],
  },
  encoderTest: {
    section: 'advanced',
    title: t('settings.encoder_kapasite_testi'),
    description: t('settings.cihazin_ayni_anda_kac_pencere'),
    keywords: ['kapasite', 'stres', 'test', t('settings.pencere_sayisi'), 'encoder'],
  },
  systemInfo: {
    section: 'advanced',
    title: t('settings.sistem_bilgisi'),
    description: t('settings.surum_cekirdek_bilesenler_ve'),
    keywords: [t('settings.surum'), 'scrcpy', 'versiyon', 'engine', 'protokol'],
  },
  architecture: {
    section: 'about',
    title: t('settings.acik_kaynak_sistem_mimarisi'),
    description: t('settings.sifir_kurulum_zero_apk_telefona'),
    keywords: ['zero apk', 'root', 'knox', 'garanti', 'adb', 'gizlilik', t('settings.acik_kaynak')],
  },
  directReply: {
    section: 'about',
    title: t('settings.bildirimlerden_dogrudan_yanit_neden'),
    description: t('settings.android_guvenlik_bariyeri'),
    keywords: ['bildirim', t('settings.yanit'), 'whatsapp', 'remoteinput', 'reply', 'telegram'],
  },
};

export const settingItem = (id) => SETTING_ITEMS[id];

// ───────────────────────────────────────────────────────────────────────────────────────── Arama

const FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

/** Küçük harf + Türkçe aksan katlama: "cozunurluk" ⇢ "çözünürlük", "ISIK" ⇢ "ışık" ile de eşleşir. */
export function fold(text) {
  return String(text ?? '')
    .toLocaleLowerCase(activeLocale())
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
  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, activeLocale()));
  return results.slice(0, limit);
}

// ───────────────────────────────────────────────────────────────────────────────────────── Seçenekler

export const RESOLUTION_OPTIONS = [
  { value: 'dynamic', label: t('common.dinamik'), description: t('settings.pencerenin_o_anki_boyutuna_otomatik'), tag: t('settings.otomatik_esnek') },
  { value: 'phone_scale', label: t('settings.telefon_olcegi_zoom'), description: t('settings.uygulamalar_telefondaki_duzenle'), tag: t('settings.telefon_duzeni') },
  { value: 'dynamic_fix', label: t('settings.dinamik_fix_tam_oturtma'), description: t('settings.video_alaninin_oranini_birebir_izler'), tag: t('settings.tam_oran') },
  { value: '1080p', label: t('settings.sabit_1080p_standart'), description: t('settings.16_9_genis_ekran_standart_masaustu'), tag: '1920×1080' },
  { value: 'tablet', label: t('settings.tablet_modu'), description: t('settings.dikey_alani_yuksek_tek_ekranda_daha'), tag: '1920×1200' },
  { value: '2k', label: t('settings.sabit_2k_masaustu'), description: t('settings.genis_ve_2k_monitorler_icin_yuksek'), tag: '2560×1440' },
  { value: '2.5k', label: t('settings.2_5k_tablet'), description: t('settings.en_yuksek_dikey_alan_dokuman_okuma_ve'), tag: '2560×1600' },
];

export const DPI_OPTIONS = [
  { value: 'auto', label: t('common.otomatik'), description: t('settings.pencere_boyutuna_gore_ergonomik'), tag: t('common.onerilen') },
  { value: '180', label: '180 DPI', description: t('settings.genis_calisma_alani_cok_sutunlu'), tag: t('common.masaustu') },
  { value: '200', label: '200 DPI', description: t('settings.gozu_yormayan_altin_oran_cogu_1080p'), tag: t('settings.optimum') },
  { value: '220', label: '220 DPI', description: t('settings.dengeli_yazi_boyutu_tablet_gorunumu'), tag: t('settings.kompakt') },
  { value: '240', label: '240 DPI', description: t('settings.genis_dokunmatik_hedefler_ve_buyuk'), tag: t('settings.buyuk_metin') },
  { value: '320', label: '320 DPI', description: t('settings.en_buyuk_simge_ve_metinler_ust_duzey'), tag: t('settings.erisilebilirlik_2') },
];

export const TARGET_DP_OPTIONS = [
  { value: 'auto', label: t('common.otomatik'), description: t('settings.pencere_boyutuna_gore_dinamik'), tag: t('common.onerilen') },
  { value: '600', label: '600 dp', description: t('settings.tablet_duzeni_iki_sutunlu_master'), tag: t('common.tablet') },
  { value: '720', label: '720 dp', description: t('settings.standart_masaustu_cok_sutunlu_dex'), tag: t('common.masaustu') },
  { value: '840', label: '840 dp', description: t('settings.genis_ekranlarda_uretkenlik_ve'), tag: t('settings.genis') },
  { value: '960', label: '960 dp', description: t('settings.16_10_dikey_alan_ve_maksimum_icerik'), tag: t('common.yogun') },
];

export const CODEC_OPTIONS = [
  { value: 'auto', label: t('common.otomatik'), description: t('settings.cihazin_donanimina_gore_en_iyi'), tag: t('common.onerilen') },
  { value: 'h265', label: 'H.265 (HEVC)', description: t('settings.daha_keskin_metin_daha_az_renk'), tag: t('settings.maksimum_netlik_2') },
  { value: 'av1', label: 'AV1', description: t('settings.yeni_nesil_ultra_verimli_yalnizca'), tag: t('settings.yeni_nesil') },
  { value: 'h264', label: 'H.264', description: t('settings.eski_donanimlar_icin_evrensel'), tag: t('settings.uyumlu') },
];

export const SHARPEN_OPTIONS = [
  { value: 'smart', label: t('settings.akilli'), description: t('settings.gozu_yormadan_dogal_ve_temiz_kenar'), tag: t('common.onerilen') },
  { value: 'ultra', label: t('settings.ultra_keskin'), description: t('settings.yuksek_kontrastli_kristal_harfler'), tag: t('settings.ultra') },
  { value: 'off', label: t('common.kapali_2'), description: t('settings.filtresiz_duz_cizim'), tag: t('settings.standart') },
];

export const FPS_OPTIONS = [
  { value: '15', label: '15 FPS', description: t('settings.dusuk_veri_kullanimi'), tag: t('settings.tasarruf') },
  { value: '30', label: '30 FPS', description: t('settings.standart_akicilik'), tag: t('common.dengeli_2') },
  { value: '60', label: '60 FPS', description: t('settings.maksimum_akicilik'), tag: t('common.onerilen') },
];

export const BITRATE_OPTIONS = [
  { value: '2', label: t('settings.2_mbps'), description: t('settings.zayif_ag_icin'), tag: t('settings.dusuk') },
  { value: '4', label: t('common.4_mbps'), description: t('settings.orta_kalite'), tag: t('common.dengeli_2') },
  { value: '8', label: t('common.8_mbps'), description: t('settings.kristal_netlik'), tag: t('common.varsayilan') },
  { value: '12', label: t('common.12_mbps'), description: t('settings.ultra_hd'), tag: t('settings.yuksek') },
  { value: '16', label: t('common.16_mbps'), description: t('settings.2k_netlik_icin_onerilir'), tag: '2K' },
  { value: '20', label: t('common.20_mbps'), description: t('settings.en_yuksek_kalite'), tag: t('settings.maksimum') },
];

export const WINDOW_LIMIT_OPTIONS = [
  { value: 'auto', label: t('common.otomatik'), description: t('settings.cihazin_test_edilmis_donanim_sinirini'), tag: t('settings.donanim_siniri') },
  { value: '2', label: t('settings.2_pencere'), description: t('settings.yan_yana_iki_canli_pencere'), tag: t('settings.2_aktif') },
  { value: '3', label: t('settings.3_pencere'), description: t('settings.dengeli_kaynak_kullanimi'), tag: t('settings.3_aktif') },
  { value: '4', label: t('settings.4_pencere'), description: t('settings.coklu_gorev_icin_ideal'), tag: t('settings.4_aktif') },
  { value: '6', label: t('settings.6_pencere'), description: t('settings.yuksek_performansli_cihazlar'), tag: t('settings.6_aktif') },
  { value: '16', label: t('settings.16_pencere'), description: t('settings.maksimum_donanim_kapasitesi'), tag: t('settings.maks_16') },
];

export const FIT_OPTIONS = [
  { value: 'fill', label: FIT_MODES.fill.label, description: t('settings.pencereyi_kenardan_kenara_doldurur'), tag: t('common.onerilen') },
  { value: 'contain', label: FIT_MODES.fit.label, description: t('settings.orani_korur_uzatmaz_yanlarda_siyah'), tag: t('settings.sifir_esneme') },
  { value: 'cover', label: FIT_MODES.cover.label, description: t('settings.uzatmadan_yakinlasir_kenardaki'), tag: t('settings.zoom_kirpma') },
];

export const AUDIO_CODEC_OPTIONS = [
  { value: 'pcm', label: t('settings.ham_pcm'), description: t('settings.sifir_gecikmeli_dogrudan_islenebilir'), tag: t('settings.sifir_gecikme') },
  { value: 'opus', label: t('settings.opus'), description: t('settings.dusuk_bant_genisligi_kullanan'), tag: t('settings.dusuk_veri') },
];

export const AUDIO_ROUTE_TEXT = {
  phone: { description: t('settings.sesler_telefonun_hoparlorunden_ya_da'), tag: t('settings.telefonda_cal') },
  pc: { description: t('settings.android_sesleri_bilgisayara_dex'), tag: t('common.onerilen') },
  both: { description: t('settings.sesler_ayni_anda_hem_telefondan_hem'), tag: t('settings.eszamanli') },
};

export const THEME_OPTIONS = [
  { value: 'light', label: t('common.acik_2'), description: t('settings.temiz_gri_beyaz_yuzeyler_yuksek'), tag: t('common.varsayilan') },
  { value: 'dark', label: t('settings.karanlik_2'), description: t('settings.derin_gece_tonlari_ve_cam_efekti_gozu'), tag: t('settings.gece') },
];

export const WINDOWING_MODE_OPTIONS = [
  { value: 'eco', label: t('common.eko_calisma_alani'), description: t('settings.paylasimli_tek_encoder_en_dusuk_isi'), tag: '1 encoder' },
  { value: 'independent', label: t('common.bagimsiz_ekranlar'), description: t('settings.her_pencere_kendi_sanal_ekraninda_en'), tag: t('settings.pencere_basina_vd') },
  { value: 'hybrid', label: t('common.hibrit_otomatik'), description: t('settings.cihaz_kapasitesine_gore_otomatik_secer'), tag: t('common.onerilen') },
];

export const HANDOFF_OPTIONS = [
  { value: 'fullscreen', label: t('common.tam_ekran'), description: t('settings.uygulama_telefonun_ekranini_tamamen'), tag: t('common.onerilen') },
  { value: 'freeform', label: t('common.serbest_pencere'), description: t('settings.hyperos_un_kendi_kucuk_penceresi'), tag: t('common.kucuk_pencere') },
];

export const APP_CLOSED_OPTIONS = [
  { value: 'close', label: t('common.pencereyi_kapat'), description: t('settings.telefondan_kapatilan_uygulamanin'), tag: t('common.varsayilan') },
  { value: 'badge', label: t('common.pencerede_goster'), description: t('settings.pencere_kalir_ustunde_yeniden_ac'), tag: t('common.yeniden_ac') },
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
      const dpi = Number(get('custom_dpi')) > 0 ? `${get('custom_dpi')} DPI` : Number(get('target_dp')) > 0 ? `${get('target_dp')} dp` : t('settings.oto_yogunluk');
      return `${labelOf(RESOLUTION_OPTIONS, get('resolution_mode')) || t('settings.dinamik')} · ${dpi}`;
    }
    case 'stream': {
      const codec = { auto: t('common.oto'), h265: 'H.265', h264: 'H.264', av1: 'AV1' }[get('video_codec')] || t('common.oto');
      return `${codec} · ${get('max_fps')} FPS · ${Math.round(get('video_bit_rate') / 1_000_000)} Mbps`;
    }
    case 'audio':
      return { pc: 'DeX', phone: t('common.telefon_2'), both: t('common.ikisi') }[get('audio_output_mode')] || 'DeX';
    case 'windows': {
      const mode = { eco: t('settings.eko'), independent: t('settings.bagimsiz_2'), hybrid_auto: t('settings.hibrit') }[get('windowing_mode')] || t('settings.hibrit');
      return `${mode} · ${get('phone_handoff_windowing') === 'freeform' ? t('settings.serbest_aktarim') : t('settings.tam_ekran_aktarim')}`;
    }
    case 'appearance':
      return live?.ambient_backdrop === false ? t('settings.arka_plan_kapali') : t('settings.sinematik_arka_plan');
    case 'power':
      return get('screen_off_while_mirroring') ? t('settings.telefon_ekrani_kararir') : t('settings.telefon_ekrani_acik');
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
    label: t('common.dengeli'),
    tagline: t('settings.gunluk_kullanim'),
    description: t('settings.akici_60_fps_ve_temiz_metin_pil_ve'),
    patch: {
      video_codec: 'auto', max_fps: 60, video_bit_rate: 8_000_000, sharpening_mode: 'adaptive',
      dynamic_resolution_enabled: true, screen_off_while_mirroring: false,
    },
  },
  {
    id: 'clarity',
    label: t('settings.maksimum_netlik'),
    tagline: t('settings.metin_ve_tasarim_isleri'),
    description: t('settings.h_265_16_mbps_ve_ultra_keskinlik_en'),
    patch: {
      video_codec: 'h265', max_fps: 60, video_bit_rate: 16_000_000, sharpening_mode: 'ultra',
      dynamic_resolution_enabled: true, screen_off_while_mirroring: false,
    },
  },
  {
    id: 'battery',
    label: t('settings.pil_isi_2'),
    tagline: t('settings.uzun_oturumlar'),
    description: t('settings.30_fps_dusuk_bit_hizi_ve_karartilmis'),
    patch: {
      video_codec: 'auto', max_fps: 30, video_bit_rate: 4_000_000, sharpening_mode: 'off',
      dynamic_resolution_enabled: false, screen_off_while_mirroring: true,
    },
  },
  {
    id: 'lowdata',
    label: t('settings.zayif_ag'),
    tagline: t('settings.wi_fi_mobil_baglanti'),
    description: t('settings.h_265_ile_2_mbps_en_dusuk_bant'),
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
      id: 'hard-refresh', tone: 'warn', title: t('settings.sert_yenileme_acik'),
      body: t('settings.dpi_degisince_uygulamalarin_sureci'),
      action: { label: t('common.kapat'), patch: { density_refresh_hard: false } },
    });
  }
  if (bitrate > 0 && bitrate <= 2_000_000 && fps >= 60) {
    out.push({
      id: 'low-bitrate-high-fps', tone: 'warn', title: t('settings.dusuk_bit_hizi_60_fps'),
      body: t('settings.2_mbps_de_60_kare_goruntude_blok_ve'),
      action: { label: t('settings.8_mbps_yap'), patch: { video_bit_rate: 8_000_000 } },
    });
  }
  if (!settingValue(live, 'dynamic_resolution_enabled') && ['dynamic', 'dynamic_fit', 'dynamic_fix'].includes(settingValue(live, 'resolution_mode'))) {
    out.push({
      id: 'real-resolution-off', tone: 'info', title: t('settings.gercek_cozunurluk_kapali'),
      body: t('settings.pencereyi_buyuttugunuzde_goruntu'),
      action: { label: t('common.ac'), patch: { dynamic_resolution_enabled: true } },
    });
  }
  if (settingValue(live, 'video_codec') === 'h264') {
    out.push({
      id: 'codec-h264', tone: 'info', title: t('settings.h_265_daha_keskin_metin_verir'),
      body: t('settings.h_264_yalnizca_eski_donanimlar'),
      action: { label: t('settings.otomatik_yap'), patch: { video_codec: 'auto' } },
    });
  }
  if (settingValue(live, 'audio_output_mode') === 'both' && Number(settingValue(live, 'audio_sync_offset_ms')) === 0) {
    out.push({
      id: 'audio-sync', tone: 'info', title: t('settings.ikisi_icin_ses_ince_ayari'),
      body: t('settings.telefon_ve_dex_sesi_arasinda_yanki'),
      action: { label: t('settings.ayara_git'), section: 'audio' },
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
