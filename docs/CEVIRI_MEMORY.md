# Çeviri hafızası (CEVIRI_MEMORY)

> Yaşayan çalışma listesi: çeviri bekleyen anahtarlar ve çeviri turu akışı. Sürecin genel anlatımı: [TRANSLATING.md](TRANSLATING.md).

Arayüz metinleri 20 dilde (`frontend/src/locales/*.json`): **tr = kaynak**, **en = İngilizce**, 18 hedef dil (de, es, fr, hi, id, it, ja, ko, ku, nl, pl, pt-BR, ru, th, uk, vi, zh-CN, zh-TW).
Bu dosya "ne, nerede çeviri bekliyor" bilgisinin tek yeridir ve geliştirme sırasında 20 dili tek tek çevirmemek içindir.

## Kural

1. **Geliştirirken çeviri yapılmaz.** Yeni/değişen arayüz metni için yalnız Türkçe (+ İngilizce yer tutucu) yazılır; diğer 18 dil sonra, toplu ve ucuz modelle çevrilir.
2. Yeni anahtar: `t('grup.anahtar')` kullan, sözlüğe ekle (aşağıda). Diller İngilizce yer tutucuyla dolar; arayüz bozulmaz.
3. **Var olan bir anahtarın Türkçe metni değiştiyse** diğer dillerdeki çeviri eskir ve araç bunu göremez: aşağıdaki **"Metni değişenler"** tablosuna bir satır ekle.
4. Çeviri turunu **kullanıcı isteyince** yap. **"Commit yap" denince, commit'ten ÖNCE hatırlat:** "çeviri bekleyen X anahtar var, çevireyim mi?" (`npm run i18n:todo` + bu dosyadaki tablolar).

## Komutlar (`frontend/` içinde)

| Komut | Ne yapar |
|---|---|
| `npm run i18n:addkeys -- sozluk.json` | Yeni anahtarlar. Dosya: `{ "grup.anahtar": ["Türkçe", "English"] }`. tr'ye Türkçe, diğer dillere İngilizce yer tutucu yazar; anahtarı aynı grubun sonuna ekler, satır sonu (CRLF) korunur. |
| `npm run i18n:todo` | **Çeviri bekleyenler**: çoğu dilde değeri İngilizceyle birebir aynı kalmış anahtarlar. Listeyi ekrana basar ve `frontend/i18n-todo.json`'a yazar (`[{key, tr, en}]`, git'e girmez). |
| `npm run i18n:apply -- <dil> <dosya.json>` | `{ "anahtar": "çeviri" }` dosyasını o dile işler. Yer tutucuları (`{{ad}}`) denetler; yalnız hâlâ İngilizce yer tutucuda duran anahtarları değiştirir (çevrilmişe dokunmaz); işlenmediyse dosyaya yazmaz. |
| `npm run i18n:status` | Dil başına eksik / fazla / yer tutucu hatası özeti (testlerin kullandığı denetim). |

`todo`, bir anahtarı yalnız **dillerin yarısından fazlasında** İngilizceyle aynıysa "bekliyor" sayar: Computer, Standard, Status gibi birkaç dilde doğal olarak aynı kalan kelimeler bekleyen sayılmaz. Her dilde bilerek aynı kalan teknik metinler `scripts/i18n.mjs` içindeki `IDENTICAL_OK` listesindedir (WPA2/3, "Dynamic‑Fix").

## Çeviri turu (ucuz model: Haiku)

1. `npm run i18n:todo` → `frontend/i18n-todo.json`.
2. Her hedef dil için modele aşağıdaki istemi ver (dil adını değiştir), **çıktıyı `ceviri-<dil>.json`** olarak kaydet.
3. `npm run i18n:apply -- <dil> ceviri-<dil>.json` (18 dil için tekrar; yer tutucu hatası olan satırlar atlanıp listelenir, onları elle düzelt).
4. `npm run i18n:status` ve `npx vitest run` (dil testleri yer tutucu eşleşmesini de kontrol eder).
5. Bu dosyadaki **"Bekleyen çeviriler"** tablosunu temizle, **"Son çeviri turları"**na tarih ekle.

### Haiku istemi (şablon)

```
Aşağıdaki JSON, bir Android'i bilgisayara aktaran masaüstü uygulamasının (OpenDeX) arayüz metinleridir: [{key, tr, en}].
Her "en" metnini <DİL ADI> diline çevir. Kurallar:
- {{ad}} biçimindeki yer tutucuları (ör. {{count}}, {{app}}, {{port}}) AYNEN koru, çevirme, sayısını değiştirme.
- Kısa arayüz metni üslubu: düğme/etiket kısa, açıklama net. Resmî değil, doğal ve samimi ("sen" yerine hedef dilin arayüzlerde yaygın kipi).
- Ürün ve oyun adlarını (OpenDeX, DeX, PUBG, Genshin Impact, WPA2…) çevirme. Kısaltmalar (DPI, dp, USB, PIN) kalsın.
- Anlam için "tr" metnine de bak; "Layout" = ekran/tuş yerleşimi, "Close/Medium/Wide" = yoğunluk seçenekleri (yakın/orta/geniş), "Stream" = canlı görüntü akışı.
- ku = Kurmancî (Latin harfli Kürtçe), zh-TW = Geleneksel Çince, zh-CN = Basit Çince, pt-BR = Brezilya Portekizcesi.
Çıktı YALNIZ şu biçimde bir JSON nesnesi olsun (açıklama yok): { "<key>": "<çeviri>", ... }
```

## Bekleyen çeviriler (elle tutulan liste)

Geliştirirken buraya satır ekle; çeviri turundan sonra sil. (`npm run i18n:todo` aynı bilgiyi otomatik verir, bu tablo "neden/nerede" notu içindir.)

| Anahtar(lar) | Nerede (dosya / ekran) | Not |
|---|---|---|

## Metni değişenler (çeviri eskidi, otomatik bulunamaz)

Var olan anahtarın **Türkçe metni değiştiğinde** ekle; çeviri turunda o anahtarı elle `ceviri-<dil>.json`'a koy (apply yalnız yer tutucudakilere dokunur — çevrilmiş satırı değiştirmek için önce `locales/<dil>.json`'da değeri `en` metnine eşitle).

| Anahtar | Eski → yeni (özet) | Tarih |
|---|---|---|

## Son çeviri turları

| Tarih | Kapsam | Yöntem |
|---|---|---|
| 2026-10-16 | 222 anahtar × 18 dil: tuş düzeni (keymapper.*), kilit/aktarım örtüleri (overlay.*), otomatik yoğunluk (taskbar.oto_*), kablosuz doğrulama hatası, ortak kısa metinler | Sonnet 5.5 (elle, dil dil); sonraki turlar için Haiku önerilir |
| 2026-10-25 | 57 anahtar × 18 dil (1026 metin): çoklu uygulama sesi (audio_focus.*, 41) + tuş düzenleyici "Oyna" / paneller / tuş tanı ve Ctrl+G bildirimleri (keymapper.*, window.tus_duzeni_*, 16); `i18n:todo` boş | Sonnet 5.5 (elle, dil dil; yer tutucular betikle doğrulandı) |
| 2026-10-28 | 88 anahtar × 18 dil (1584 metin): Telefon Yükü paneli (telemetry.*, 40), arama içi seçenek eşleşmesi (settings.eslesen_secenekler), uygulama çekmecesi (launcher.*, 50); metni değişen 2 telemetry anahtarı yeniden çevrildi; `i18n:todo` boş | Haiku (dil başına bir ajan, paralel; yer tutucular `i18n:apply` ile doğrulandı) |
| 2026-10-30 | 112 anahtar × 18 dil (2016 metin): Telefon ayarları (footprint.*, 81) + Telefon Yükü akış paneli: telefonun işi / ağın işi / sıkıştırma (telemetry.akis_*, 31); kullanılmayan 3 telemetry anahtarı silindi; `i18n:todo` boş | Haiku (tek ajan, 18 dil sırayla — önbellekten yararlanmak için dil başına ajan açılmadı; yer tutucular `i18n:apply` ile doğrulandı) |

## Notlar

- Çeviriler yapay zekâ üretimidir, ana dili konuşan biri gözden geçirmedi (RTL diller ertelendi).
- Yeni anahtar eklerken backend'den dönen metni arayüze **koyma**: backend Türkçe sabit metin döndürürse diğer dillerde Türkçe görünür. Backend `code` döndürsün, arayüz `t()` ile çevirsin (örnek: `POST /api/device/tcpip` → `code: unverified|no_device|failed`, `useDeviceHub.wirelessErrorText`).
- Düzenleyicilerde JSON dosyaları **CRLF** (Windows). Araçlar satır sonunu korur; elle kaydederken değiştirme.
