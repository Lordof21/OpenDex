> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). The OpenDeX logo: the decision, the colours and the rules for using it.

# OpenDeX logosu — marka notu

## Güncel durum

Logo olarak seçilen Gemini görseli kullanılıyor. Dosyalar:

| Ne | Yol |
|---|---|
| Kaynak görsel | [`opendex-logo-source.jpg`](opendex-logo-source.jpg) |
| Vektör iz (işaret) | `frontend/public/brand/logo-mark.svg` — açılış ekranı bunu maske olarak `--primary` rengiyle kullanır |
| Favicon | `frontend/public/favicon.svg` |
| Uygulama ikonu | `frontend/src-tauri/icons/icon.png`, `icon.ico` (şeffaf zemin, mürekkep rengi) |

Windows ikonu: `icon.ico` içinde 16–256 px arası 15 boyut var (görev çubuğu 24/30/36/48…, başlık/tepsi 16/20/24/32…); ≤40 px karelerde çizgi 1,7 px'e kalınlaştırılır. Pencere/görev çubuğu ikonunu `frontend/src-tauri/src/window_icon.rs` eklentisi tam boyutlu kareyle kurar (Tauri varsayılan olarak ICO'nun ilk girişini tek bitmap verip Windows'a ölçeklettirir → bulanıklık). İkonu yeniden üretmek için `scripts/make_app_icon.py`; `build.rs` ikon değişince yeniden çalışır; canlı HWND ikonunu üretimden sonra gözle doğrula.

Daha önce hazırlanan SVG işaret ailesi (`opendex-mark*.svg`, piksel-mükemmel 16 / 64 ızgaraları) bu karardan önce hazırlandı ve **kaldırıldı**; aşağıdaki kavram ve renkler yine geçerli.

## 1. Kavram

**Bir pencerenin içinde telefon.** OpenDeX her telefon uygulamasını masaüstünde kendi penceresinde açar; işaret bunu anlatır: bir masaüstü penceresi (çerçeve + başlık çubuğu) ve pencerenin sağ alt köşesinden taşan bir telefon. Açılış ekranındaki monitör + telefon motifi (`BootSplash.jsx`) ile uyumludur. Mavi ekran uygulamanın kendi **OpenDeX seri rengidir** (`--viz-opendex`, telemetri grafikleri).

## 2. Renkler

Renkler uygulamanın token'larından alındı (`frontend/src/index.css`, OKLCH → sRGB):

| Rol | Hex | Token | Kullanım |
|---|---|---|---|
| Mürekkep (çerçeve, başlık, telefon gövdesi) | `#282019` | `--primary` (açık tema) | açık zeminde ana renk |
| Krem | `#ebe7e2` | `--primary` (koyu tema) | koyu zeminde ana renk |
| Mavi ekran (açık tema) | `#2a78d6` | `--viz-opendex` (açık) | telefon ekranı |
| Mavi ekran (koyu tema) | `#3987e5` | `--viz-opendex` (koyu) | koyu zeminde telefon ekranı |
| Açık zemin | `#f7f5f1` | `--background` (açık) | açık ikon kutusu |
| Koyu zemin | `#211d19` | `--card` (koyu) | koyu ikon kutusu |

Kontrast (WCAG, grafik öğeler için ≥3:1): mürekkep/açık zemin 14,71:1 · mavi ekran/açık zemin 4,06:1 · krem/koyu zemin 13,60:1 · koyu mavi ekran/koyu zemin 4,60:1.

## 3. Kurallar

- Yalnız bu paletten renk. Gradyan, gölge, parıltı, kabartma, 3B, yazı yok (işarette harf yok).
- Telefon ekranı düz mavi kalır (içinde başka simge ya da yazı yok).
- Pencere sol üst, telefon sağ alt; yerleri değişmez.
- Mavi dışında vurgu rengi yok; "tehlike/uyarı" renkleri markada kullanılmaz.
- Android robotu, Windows/Apple logosu, scrcpy logosu birlikte kullanılmaz.
- Minimum boyut 16 px. 24 px için ayrı piksel-mükemmel tasarım yoktur; 16 ya da 32 px kullanılır.

## 4. Uygulama içi ikonlar

Uygulamanın yerleşik ikonları (Dosyalar, OpenDeX Ayarları, Telefon Ekranını Yansıt, Çalışma Alanı) kodla çizilir ve renkleri `index.css`'teki `--app-*` token'larından gelir; ayrı görsel dosya ya da üretken-model istemi gerekmez.
