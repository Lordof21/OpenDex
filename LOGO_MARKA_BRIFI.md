# OpenDeX logosu — marka brifi

> **Güncel durum (2026-10-17):** Logo olarak kullanıcının seçtiği Gemini görseli kullanılıyor (kaynak: `docs/brand/opendex-logo-source.jpg`;
> vektör izi `frontend/public/brand/logo-mark.svg`, favicon `frontend/public/favicon.svg`, uygulama ikonu `frontend/src-tauri/icons/icon.png|ico`
> — şeffaf zemin, mürekkep rengi; açılış ekranı SVG'yi maske olarak `--primary` rengiyle kullanır).
> Windows ikonu: `icon.ico` içinde 16–256 px arası 15 boyut var (görev çubuğu 24/30/36/48…, başlık/tepsi 16/20/24/32…); ≤40 px karelerde çizgi
> 1,7 px'e kalınlaştırılır. Pencere/görev çubuğu ikonunu `frontend/src-tauri/src/window_icon.rs` eklentisi tam boyutlu kareyle kurar (Tauri varsayılan
> olarak ICO'nun ilk girişini tek bitmap olarak verip Windows'a ölçeklettiriyor → bulanıklık).
> Aşağıdaki SVG konsepti ve dosya listesi bu karar öncesi hazırlanmıştı; o SVG dosyaları kaldırıldı, bu bölümler tarihsel kayıt olarak duruyor.

Bu dosya logonun kararlarını, renklerini, geometri kurallarını ve üretken bir görsel modeli için kullanılan prompt'u tek yerde toplar.
Ana kaynak SVG dosyalarıdır (`frontend/public/brand/`); bu brifi ve prompt, o dosyaların nasıl üretildiğini açıklar.

## 1. Kavram

**Bir pencerenin içinde telefon.** OpenDeX her telefon uygulamasını kendi penceresinde masaüstünde açar; işaret bu fikri doğrudan
anlatır: bir masaüstü penceresi (çerçeve + başlık çubuğu) ve pencerenin sağ alt köşesinden taşan bir telefon.

Neden bu kavram:
- Açılış ekranında zaten **monitör + telefon** motifi kullanılıyor (`BootSplash.jsx`: `Monitor` + `Smartphone` simgesi). İşaret bu motifi
  tek bir markaya çevirir.
- Bugün üç farklı kimlik var: Tauri uygulama ikonu (`src-tauri/icons/icon.png`, mavi zemin üzerinde beyaz "O"), tarayıcı favicon'u
  (`public/favicon.svg`, lacivert ve gök mavisi — uygulamanın hiçbir renk token'ında yok) ve açılış ekranındaki monitör simgesi.
  Yeni işaret üçünü birleştirmek için tasarlandı.
- Mavi ekran, uygulamanın kendi **OpenDeX seri rengi**dir (`--viz-opendex`, telemetri grafikleri). Yani mavi, ürünün "kendisini" temsil eden renk.

## 2. Renkler

Renkler uygulamanın token'larından alındı (`frontend/src/index.css`, OKLCH → sRGB dönüşümü ile hex). Tahmin yok.

| Rol | Hex | Kaynak token | Kullanım |
|---|---|---|---|
| Mürekkep (çerçeve, başlık, telefon gövdesi) | `#282019` | `--primary` (açık tema) | Açık zemin üstünde ana renk |
| Krem (çerçeve, gövde) | `#ebe7e2` | `--primary` (koyu tema) | Koyu zemin üstünde ana renk |
| Mavi ekran (açık tema) | `#2a78d6` | `--viz-opendex` (açık) | Telefon ekranı |
| Mavi ekran (koyu tema) | `#3987e5` | `--viz-opendex` (koyu) | Koyu zeminde telefon ekranı |
| Açık zemin (ikon kutusu) | `#f7f5f1` | `--background` (açık) | Açık ikon kutusu |
| Koyu zemin (ikon kutusu) | `#211d19` | `--card` (koyu) | Koyu ikon kutusu |

Kontrast (WCAG, grafik öğeler için en az 3:1):

| Eşleşme | Oran |
|---|---|
| Mürekkep / açık zemin | 14,71:1 |
| Mavi ekran / açık zemin | 4,06:1 |
| Krem / koyu zemin | 13,60:1 |
| Koyu mavi ekran / koyu zemin | 4,60:1 |

Kurallar: yalnız bu paletten renk. Ekran mavisi başka bir mavi/mor/turuncu ile değiştirilmez. Gradyan, gölge, parıltı yok.

## 3. Geometri

İki ana tasarım var, her biri belli boyutlar için "piksel-mükemmel" (her kenar tam piksele oturur):

| Dosya | Izgara | Ne zaman | Piksel-mükemmel boyutlar |
|---|---|---|---|
| `opendex-mark-16.svg` / `-16-dark.svg` | 16 piksel (piksel sanatı) | ≤ 48 px: favicon, sekme, tepsi, küçük simgeler | 16, 32, 48, 64 (×1, ×2, ×3, ×4) |
| `opendex-mark.svg` / `-dark.svg` | 64 birim (yuvarlatılmış) | ≥ 64 px: açılış ekranı, README, büyük simgeler | 64, 128, 256, 512 (×1, ×2, ×4, ×8) |
| `opendex-app-icon.svg` / `-dark.svg` | 512 tuval, zemin kare | Uygulama ikonu (Tauri, .ico/.png) | 512 (ölçek 6, tam sayı ofset 64) |

Önemli: **24 px için piksel-mükemmel bir ana tasarım yok** (16 ve 64 ızgaralarının ikisi de 24'ün katı değil; 1 birim 1,5 piksel olur ve kenarlar yarım piksele düşer).
24 px simge gerekirse 16 ya da 32 px'lik dosyanın ölçeklenmiş hâli kullanılmaz; 16 ve 32'yi kullan.

64 birim ana tasarımın ölçüleri:
- Pencere dış çerçevesi: (7,7)–(51,43), köşe yarıçapı 6; iç boşluk (10,10)–(48,40), yarıçap 3 → çerçeve kalınlığı 3 birim.
- Başlık çubuğu: (10,14)–(48,16), 2 birim.
- Telefon: (37,23)–(57,57), yarıçap 5; ekran (40,26)–(54,54), yarıçap 2 (gövde kalınlığı 3 birim).
- Ayırma boşluğu: pencere, telefonun çevresinde 2 birimlik bir boşlukla kesilir (SVG maskesi, `od-knockout`).
- Bounding box: x 7–57, y 7–57 → 64 birimin tam ortası (merkez 32, 32).

16 piksel ana tasarımın ölçüleri: pencere üst bandı (2–9, 1–2) dolu; sol kenar x=1, y 2–7; sağ kenar x=10, y 2–3; alt kenar (2–7, 8).
Telefon gövdesi (9–14, 5–13) mürekkep, ekran (10–13, 6–12) mavi. Tüm dikdörtgenlerin köşeleri tam sayı; `shape-rendering="crispEdges"`.
Boyutlar 1 piksel = 1 birim; bbox 1–14 × 1–13 → yatay ortalı (her iki yanda 1 piksel).

Uygulama ikonu: 512 tuval, köşe yarıçapı 112 (~%22), 64 birimlik işaret `translate(64 64) scale(6)` ile ortalanır; işaret tuvalin %59'unu kaplar.

Boşluk (clear space): işaretin her kenarında, çerçeve kalınlığı kadar (3 birim ≈ işaret genişliğinin %6'sı) boş alan.
Minimum boyut: 16 px (16 piksel ana tasarım).

## 4. Dosyalar

```
frontend/public/brand/
  opendex-mark.svg           64 birim, açık zemin için (mürekkep + mavi), şeffaf
  opendex-mark-dark.svg      64 birim, koyu zemin için (krem + koyu mavi), şeffaf
  opendex-mark-16.svg        16 piksel ana tasarım, açık zemin
  opendex-mark-16-dark.svg   16 piksel ana tasarım, koyu zemin
  opendex-app-icon.svg       512 kare, açık zemin (#f7f5f1), köşe 112
  opendex-app-icon-dark.svg  512 kare, koyu zemin (#211d19), köşe 112
```

Kontrol: Edge (headless) ile 16, 32, 48, 64, 128, 256 ve 512 px'te render edildi; 16 ve 64 piksel ana tasarımlar büyük ölçekte
piksel ızgarasında incelendi (kenarlar tam piksel, boşluklar tutarlı). Bu kontrol tek seferlik ve repoya bir araç olarak eklenmedi.

## 5. Kullanılmayacak yerler / yasaklar

- Gradyan, gölge, parıltı, kabartma, 3B, yazı (işarette harf yok).
- Telefon ekranında başka bir içerik (uygulama simgesi, yazı) — ekran düz mavi kalır.
- Pencere ve telefonun yerleri değişmez (telefon sağ alt, pencere sol üst).
- Mavinin dışında vurgu rengi yok; "tehlike/uyarı" renkleri markada kullanılmaz.
- Android robotu, Windows/Apple logosu, scrcpy logosu bir arada kullanılmaz.

## 6. Üretken görsel modeli için prompt (keşif amaçlı)

Üretken modeller piksel-mükemmel çıktı vermez; bu prompt yalnız alternatif kompozisyon ve bakış açısı aramak için kullanılır. Kesin
dosya her zaman yukarıdaki SVG'lerdir. Çıktı bir tasarım fikridir, üretim dosyası değil.

**Prompt (İngilizce; modeller bu dilde daha kararlı sonuç verir):**

```
ROLE: You are a senior brand designer producing a flat vector app icon concept.

PRODUCT: OpenDeX, a Windows desktop app that turns an Android phone into a multi-window desktop. Each phone app runs in its
own resizable desktop window. The brand motif is a desktop window with a phone overlapping its lower-right corner.

COMPOSITION (exact):
- Square canvas 1024x1024. Rounded-square tile, corner radius about 22% of the width.
- Tile background: flat warm off-white #F7F5F1.
- Centered mark occupying about 59% of the tile width, with equal margins on all four sides.
- Desktop window: outline in ink #282019, rounded corners (radius about 12% of the mark width), frame thickness 3 units
  of a 64-unit grid, with a solid title bar 2 units tall at the top.
- Smartphone: portrait rectangle (width:height about 20:34), rounded corners, ink #282019 body ring 3 units thick,
  screen filled with flat blue #2A78D6. The phone overlaps the window's lower-right corner, and the window is cut away
  around the phone with a 2-unit gap so the two shapes separate cleanly.

STYLE: flat vector, geometric, calm, minimal, Apple-like restraint. Crisp edges, no anti-aliasing artefacts, all edges
aligned to a 64-unit grid. Two colors only (ink and blue) plus the background.

FORBIDDEN: gradients, gloss, shadows, bevels, 3D, skeuomorphism, text or letters, watermarks, photographs, noise, blur,
device brands, the Android robot, Windows or Apple logos, emoji, cartoon characters, extra devices or screens.

DELIVERABLES: (1) the tile version on #F7F5F1; (2) a transparent-background version of the mark only; (3) a dark version
on #211D19 with the mark in #EBE7E2 and the screen in #3987E5.

SELF-CHECK before you answer:
- Is the phone clearly in front of the window, with a visible gap?
- Is the title bar solid and the frame thickness constant everywhere?
- Is the mark still recognisable at 16 px (squint test)?
- Are there exactly two colours in the mark?
- Is the mark centered with equal margins?
```

**Negative prompt (modeller ayrı alan kabul ederse):**
`gradient, glossy, 3D, bevel, drop shadow, glow, text, letters, watermark, photo, realistic, Android robot, Windows logo,
Apple logo, cartoon, emoji, blur, noise, extra devices, multiple phones, rounded blobs, outline stroke wobble`

**Değerlendirme (her çıktı için):** renk eşleşmesi (hex), iki renk dışında renk yok, yazı yok, telefon pencerenin önünde ve boşluklu,
başlık bandı dolu, 16 px'te okunuyor, bounding box ortalı. Biri eksikse çıktı kullanılmaz; SVG ana tasarım dosyası ile karşılaştırılır.

## 7. Yapılmadı / sonraki adımlar

1. **Onay:** Kavramı ve renkleri onaylamanı bekliyorum.
2. **Favicon:** `frontend/public/favicon.svg` hâlâ eski lacivert tasarım. Onay sonrası 16 piksel ana tasarımla değiştirilir.
3. **Açılış ekranı:** `BootSplash.jsx`'teki monitör simgesi işaretle değiştirilebilir.
4. **Uygulama ikonu:** `src-tauri/icons/` (`icon.png`, `icon.ico`) yeniden üretilmeli. Bu, 512 tuvalinden PNG ve çok boyutlu ICO
   (16–256) üretmeyi gerektirir. Henüz yapılmadı; mevcut "O" ikonu duruyor.
5. **README:** Üst kısma logo eklenebilir.

Bu adımlar uygulama dosyalarına dokunduğu için onayını bekliyorum.
