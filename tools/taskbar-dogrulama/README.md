# Görev çubuğu — doğrulama araçları

**Gerçek `Taskbar.jsx` + `WindowPreview.jsx` + `TitleBar.jsx` + `AltTabSwitcher.jsx`** bileşenlerini gerçek Chromium'da sınar; backend/telefon gerekmez
(fetch taklidi, sahte "canlı video" tuvalleri, ikon istekleri `page.route` ile yanıtlanır). Üretim kodunun parçası değildir.

```bash
tools/taskbar-dogrulama/run.sh     # http://localhost:5200/harness.html?w=1280&h=500&theme=light|dark&wins=3&workspace=1
                                   #   ?scene=titlebars → gerçek başlık çubukları alt alta (ikon doğrulaması)
cd tools/taskbar-dogrulama
node e2e.cjs                       # uçtan uca denetim (aşağıda); OUT_DIR=… verilirse ekran görüntüleri de yazılır
```

Ortam: `HARNESS_URL`, `PLAYWRIGHT_PATH`, `CHROME_PATH`, `OUT_DIR` — diğer `tools/*-dogrulama` araçlarıyla aynı. `run.sh` harness dosyalarını geçici olarak
`frontend/` altına kopyalar ve çıkışta siler. **Not:** Vite kopyayı servis eder; `harness.jsx`'i çalışırken değiştirirseniz kopyayı da güncelleyin.

## Bu araçla bulunan / doğrulanan hatalar

| Belirti | Kök neden | Düzeltme |
|---|---|---|
| 2. ve sonraki uygulamada alt çizgi (ve ikon) sola kayık | `TaskbarApp` kökü `grid`, ama 2.+ düğmeye `min-[600px]:inline-flex` veriliyordu → `display` eziliyor, `place-items-center` etkisiz, çizgi 18 px solda | düzen sabit `flex items-center justify-center`; gizleme `max-[…]:hidden`; çizgi açıkça `left-1/2 -translate-x-1/2` |
| Hiçbir pencere "aktif" görünmüyor; açık pencerenin düğmesine/önizlemesine basınca hiçbir şey olmuyor | `Taskbar` store'da OLMAYAN `activeWindowId`'yi okuyordu → hep `undefined` | `taskbarModel.isWindowActive` (`focused && !minimized`) + `toggleActionFor` (restore / minimize / focus) |
| Dikey (telefon) pencerenin önizlemesinde yalnız "baş" görünüyor | önizleme tuvali sabit `h-32` ızgara hücresinde; `h-full` yüzdesi otomatik satıra (= tuvalin öz yüksekliği, ör. 711 px) çözülüyor, taşan kısım kırpılıyor | kutu pencerenin gerçek oranında (`fitBox`), piksel boyutu açıkça verilir |
| Önizleme bulanık/tırtıklı | tam çözünürlüklü kare her frame (60 fps) kopyalanıp CSS ile küçültülüyordu | ekran pikselinde (CSS × dpr) çok adımlı küçültme (`lib/downscale.js`), canlıda ~15 fps; küçük resim önbelleği 320 → 640 px, oran bozulmaz |
| Önizlemede sahte "Apple" pencere başlığı | gereksiz üç noktalı şerit | kaldırıldı; kart başlığında ikon + ad + kapat var |
| Pencere/başlık/Alt-Tab ikonu yalnız baş harf | `TitleBar`, `WorkspaceTaskFrame`, `AltTabSwitcher` `title.slice(0,1)` basıyordu | `AppIcon` (`iconPackageOf`) — VD: uygulama ikonu; Dosyalar / Telefon / Çalışma Alanı: özel ikon |
| Çalışma Alanı kabı için ikon yok (kabın paketi `null`) | harf yedeği | `WORKSPACE_ICON_PACKAGE` + özel `WorkspaceGlyph` simgesi (`.app-icon-workspace`) |

## `e2e.cjs` neleri denetler

Alt çizgi/ikon hizası (1280 ve 700 px), tek aktif düğme ve geniş çizgi, düğme tıklaması (küçült → geri yükle → arkadaki öne gelir), önizleme: gerçek oran
(16:9 / 0.45), dört kenarın görünmesi (kırpılmama), ekran pikselinde çizim, sahte başlık yok, tooltip çakışması yok, önizlemeye tıklama = düğmeyle aynı eylem
(öne getir / küçült / geri yükle) ve kartın kapanması, küçültülmüş pencerenin önbellekten tam kareyle önizlenmesi, Çalışma Alanı ikonu ve önizlemesi, X ile kapatma,
gerçek uygulama ikonunun yüklenmesi, konsolda hata yok.
