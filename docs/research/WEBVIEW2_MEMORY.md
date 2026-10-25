> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). Why the WebView2 renderer holds ~1 GB with a 1080p HEVC stream, and the fixes.

# WebView2 bellek kullanımı — derin araştırma ve çözüm raporu

Tarih: 2026-10-23 · Kapsam: DeX arayüzü (Tauri / WebView2), 1920×1080 pencere, HEVC akışı
Bu rapor ürün sahibi için yazıldı: ne ölçtük, neyi kanıtladık, neyi bilmiyoruz, ne öneriyoruz, hangi karar bekliyor.
Ölçüm dosyaları ve betikler: `…/scratchpad/lab/` (yeniden üretilebilir; sonda).

---

## 1) Üç cümlelik özet

1. **Suçlu codec (HEVC) değil, görüntü hattı da değil.** Sade bir sayfada gerçek HEVC akışı 1080p60'ta GPU sürecini yalnızca **~126 MB** tutuyor; bizim arayüzde tek canvas'a indirgenmiş hâli **~275 MB** (boşta taban 240). Eski kare saklamıyoruz, `VideoFrame` hemen kapatılıyor.
2. **1 GB'ın büyük kısmı canvas'ın etrafındaki arayüzün bileşimlenmesinden geliyor** (bulanık arka plan resmi, gölgeler, SVG keskinleştirme filtresi, `backdrop-filter`). Tek başına en büyük kalem **"ambient" bulanık arka plan: ~285 MB**. Bunun bir kısmı kodda düzeltilebiliyor (yama hazır, **−170…−200 MB**, 55 test geçti).
3. **"Pencereyi kapattım, 500 MB duruyor"**: Chromium GPU belleğini geri vermiyor (kapanıştan 2+ dk sonra bile ~620 MB). Resmî çözüm WebView2'nin **`MemoryUsageTargetLevel = Low`** ayarı: gerçek Tauri/WebView2 üzerinde denendi, pencere kapalıyken toplam WebView2 **~790 MB → ~46 MB**.

---

## 2) Sorularınız ve cevapları

| Soru | Cevap | Kanıt |
|---|---|---|
| 300 MB olması gerekirken neden 1,2 GB? | 300 MB bu mimaride gerçekçi bir hedef değil: boşta GPU tabanı 240, canvas +40, renderer/ana süreç/yardımcılar ~250 daha. Gerçekçi hedef **akış sırasında ~750–850 MB, pencere yokken ~100–130 MB** (bkz. §5). 1,2 GB'ın nedeni arayüz bileşimlemesi (§3). | §3 tablo |
| Buffer eski/gereksiz kareleri tutuyor mu? | **Hayır.** Çözülen her kare çizilir çizilmez `close()` ediliyor, kare kuyruğu yok, çözücü kuyruğu 90'ı geçerse sıfırlanıyor. Backend'de yalnızca yeni bağlanan istemci için sınırlı (≈12 sn, pencere başına ~12 MB) GOP önbelleği var. | [videoDecoder.js](../../frontend/src/media/videoDecoder.js), [broadcaster.py:59](../../backend/app/streams/broadcaster.py#L59) |
| Canvas/context pikselleri RAM'den temizleniyor mu? Çöp toplayıcı yeter mi? | **Kısmen hayır.** `destroy()` canvas'ı serbest bırakmıyordu; GPU piksel belleği çöp toplayıcı elemana ulaşana kadar tutuluyordu (Chromium geliştiricisi tavsiyesi: atmadan önce `width=height=0`). Ayrıca her pencerede ikinci tam boy "freeze" canvas'ı hiç küçülmüyordu. Düzeltme yamada. **Not:** bu tek başına kapanış sonrası belleği düşürmedi (§3-D), asıl kapanış çözümü `MemoryUsageTargetLevel`. | [VideoCanvas.jsx:564](../../frontend/src/window/VideoCanvas.jsx#L564), [Chromium graphics-dev](https://groups.google.com/a/chromium.org/g/graphics-dev/c/-0v7NwYq2-s) |
| HEVC fazla bellek mi yiyor? | **Hayır.** Sade sayfada HEVC donanım 126 MB < H.264 donanım 171 MB. Asıl tuzak H.264 **yazılım** çözme: **609 MB**. HEVC'nin yazılım yedeği hiç yok (bu makinede `hevc prefer-software: desteklenmiyor`). | §3-B |
| JS çöp toplama/yığın sorunu var mı? | **Yok.** Taze arayüzde JS yığını 6 MB, 427 DOM düğümü; renderer 100–150 MB. | CDP `Performance.getMetrics` |
| Pencere kapanınca neden 500 MB duruyor? | Chromium'un GPU süreci havuzlanmış belleği bırakmıyor (2+ dk). `MemoryUsageTargetLevel=Low` ile 790 → 46 MB. | §3-D |

---

## 3) Ölçümler

Tüm sayılar bu makinede (1920×1080, Windows ölçek %125, AMD iGPU + NVIDIA; işi AMD iGPU yapıyor, ayrılmış bellek 512 MB → taşan her şey **sistem RAM'i**). Bellek = GPU süreci özel (USS) MB. Çalışmalar arası sapma ≈ ±40–60 MB; bu yüzden "tek çalıştırma" farkları buna göre okunmalı.

### A) Önceki oturumdaki gerçek durum (sizin dev uygulamanız, YouTube 1080p60 HEVC)
WebView2 toplam RSS **1712 MB** (özel 1364 MB); GPU süreci **~1000–1057 MB, 60 sn boyunca sabit (sızıntı değil)**; renderer ~200–216 MB; Windows sayaçları: **963 MB paylaşılan (sistem RAM'i)**, yalnızca 69 MB ayrılmış video belleği.

### B) Sade sayfa laboratuvarı (arayüz YOK; 1920×1080, 60 fps, 30 sn, `VideoDecoder → drawImage → close`)

| Senaryo | GPU süreci (oynarken) | Durdurunca |
|---|---|---|
| **HEVC donanım + drawImage** (gerçek telefon akışı, 8,4 Mbps) | **126 MB** | 108 MB |
| HEVC donanım, çizim yok | 99 MB | 74 MB |
| H.264 donanım + drawImage (sentetik) | 171 MB | 121 MB |
| H.264 donanım, çizim yok | 119 MB | 68 MB |
| **H.264 YAZILIM + drawImage** | **609 MB** | 407 MB (+28 sn) |

→ Görüntü hattı (çözme + çizme) ucuz. Bu Edge sürümünde HEVC/AV1 için *kodlayıcı* yok (yalnız çözücü); HEVC testi telefondan kaydedilen gerçek akışla yapıldı.

### C) Gerçek arayüz, taze süreçte, pencere akıyor (ayrı Edge profili, aynı Chromium motoru)

| Varyant | GPU süreci |
|---|---|
| Arayüz, hiç pencere yok | **~240** |
| Mevcut arayüz + akış | **660–820** |
| Mevcut, **yalnız canvas (arayüzün geri kalanı gizli)** | **270–280** → görüntü hattı yalnızca ~+40 |
| Mevcut, tüm efektler kapalı | 459 |
| Mevcut, yalnız **ambient (bulanık arka plan) gizli** | **486** (−285) |
| Mevcut, yalnız canvas gölgesi (`box-shadow`) kapalı | 687 (−85) |
| Mevcut, yalnız SVG keskinleştirme filtresi kapalı | 715 (−55) |
| Mevcut, yalnız `backdrop-filter` kapalı | 739 (−30) |
| Mevcut, yalnız duvar kâğıdı gizli | 745 (−25) |
| **Yamalı arayüz** (ambient 48 px örnek + canvas bırakma) | **550–600** |
| Yamalı + "ucuz ambient" (CSS blur/ölçek yok) | 493 |
| … + canvas gölgesi yok | 480 |
| … + `backdrop-filter` yok | 419 |
| … + SVG keskinleştirme yok (gölgesiz üstüne) | 412 |
| Yamalı + yalnız canvas yalıtılmış | 248 |

Efektler tek tek çıkarılınca toplamları aşıyor çünkü birbirini kapsıyor (aynı bileşim katmanını paylaşıyorlar).
**Yöntem uyarısı:** bu tabloyu, süreç çalışırken CSS kapatarak değil, her varyantı **taze süreçte** ölçerek çıkardım. İlk denemem (çalışırken kapatma) yanıltıcıydı çünkü Chromium ayırdığı GPU belleğini hemen geri vermiyor.

### D) Kapanış davranışı
| Durum | Sonuç |
|---|---|
| Edge, pencere kapandı (yamasız) | 707 → 649 MB (120 sn'de, yavaş) |
| Edge, pencere kapandı (yamalı) | 632 → 629 MB (**düşmüyor**) |
| Edge, + `Memory.simulatePressureNotification(critical)` | 635 → 605 (**çok az**) |
| **Gerçek Tauri/WebView2, `MemoryUsageTargetLevel=Low`** | kapanış +30 sn: **791 MB toplam** → Low +50 sn: **46 MB**, +90 sn: 131 MB. `Normal`'e dönünce 138 MB, kullandıkça büyüyor |

Low'da renderer 101 → 30 MB'a anında, GPU süreci 622 → 15 MB'a (çalışma kümesi) iniyor. Microsoft belgesi bunu "bazı belleğin diske atılması" olarak tarif ediyor; Görev Yöneticisi'nde RAM kullanımı düşer, tekrar kullanınca sayfa belleğe geri gelir (kısa gecikme).

---

## 4) Kök nedenler (kanıt düzeyiyle)

| # | Neden | Kanıt | Etki |
|---|---|---|---|
| R1 | **Ambient bulanık arka plan**: pencere başına 500 ms'de bir tam 1080p canvas'ı `toDataURL` ile JPEG'e çevirip (tam boy GPU okuması, ~200 KB dize, 8 MB çözülmüş bitmap) 1,5× ölçekli, `blur-3xl` (64 px) bir `<img>`'e basıyor | **Ölçüldü** (−285 MB; yama −125…−170) | **En büyük** |
| R2 | Canvas'ın `box-shadow: 0 8px 32px` gölgesi | Ölçüldü (−85, yamalıda −105) | Orta |
| R3 | SVG `feConvolveMatrix` keskinleştirme filtresi (varsayılan "adaptive") her karede ek bir render yüzeyi | Ölçüldü (−55…−70) | Orta |
| R4 | `backdrop-filter` (görev çubuğu, paneller; 63 kullanım) | Ölçüldü (−30…−70) | Küçük–orta |
| R5 | Pencere kapanınca Chromium GPU havuzunu bırakmıyor | Ölçüldü (Low ile çözüldü) | Kapanış sonrası ~500 MB |
| R6 | `destroy()` canvas'ı bırakmıyor; ikinci "freeze" canvas hiç küçülmüyor | Kod + web kaynağı; tek başına ölçülebilir fark yok | Düzgün temizlik için gerekli |
| R7 | Boşta tabanın kendisi (~240 MB GPU + ~250 MB renderer/ana/yardımcı) | Ölçüldü | Azaltılamaz |

**Bilmediklerimiz (dürüstçe):** (a) Laboratuvardaki tüm varyantlar Ayarlar uygulaması + hafif kaydırma ile ölçüldü; **gerçek YouTube** akışı (daha yüksek kare hızı/karmaşıklık) dev uygulamanızda ~1000 MB gösterdi, laboratuvar aynı koddan ~700–820. Aradaki fark tam açıklanamadı (içerik farkı, WebView2 ↔ Edge, dev modu StrictMode çift bağlama). (b) Çok pencereli ölçeklenmeyi ölçmedim. (c) Release derlemesini YouTube ile ölçemedim (Defender backend dosyasını siliyor, bkz. önceki yazışma). (d) Görsel kalite etkisini (ucuz ambient, gölgesiz canvas) gözle değerlendirmedim: bunu siz yapacaksınız.

---

## 5) Çözüm planı (kazanç/risk/efor)

| Öncelik | İş | Beklenen kazanç | Risk | Efor | Durum |
|---|---|---|---|---|---|
| **P0** | **`MemoryUsageTargetLevel` politikası**: akan pencere yokken ve arayüz arka plandayken `Low`, yeni pencere/etkileşimde `Normal` | Pencere yokken **790 → ~50–130 MB** | Düşük: geri dönüşte kısa gecikme (diskten geri yükleme); akış sürerken **asla Low yapılmaz** | ~½ gün (Rust komutu + ~15 satır arayüz) | Rust komutu hazır ve **denendi**: `frontend/src-tauri/src/webview_memory.rs` (yama olarak değil, uygulanmış hâliyle). Politika kodu yazılmadı |
| **P1** | **Ambient arka planı ve canvas/pencere gölgelerini KALDIRMA** (sizin kararınız, 2026-10-24) + canvas ve freeze canvas'ın pencere kapanınca açıkça bırakılması | Ambient −285 MB, gölge −85 MB (tek tek ölçülen; birlikte çakıştıkları için toplam daha az) | Düşük: video etrafındaki boşluk artık düz zemin | **UYGULANDI** (commit edilmedi) | [VideoCanvas.jsx](../../frontend/src/window/VideoCanvas.jsx); Ayarlar'dan "Sinematik arka plan" anahtarı da çıkarıldı; 12 dosya/141 test geçti. `ambient_backdrop` backend alanı geriye uyumluluk için duruyor, artık işlevsiz |
| ~~P2~~ | ~~Ambient'i ucuzlat / gölgeyi küçült~~ | — | — | — | Gereksiz: P1'de tamamen kaldırıldı |
| **P3** | SVG keskinleştirmeyi canvas'a özel hafif bir çözüme taşı ya da varsayılanı "kapalı" yap | −55…−70 MB | **Orta: görüntü netliği/ürün kimliği** | Gün | Ürün kararı |
| **P3** | `backdrop-filter`'i video üstüne binen yerlerde opak/yarı saydam zeminle değiştir | −30…−60 MB | Orta: cam efekti kaybı | Gün | Ürün kararı |
| — | Codec/çözünürlük değiştirme | Gerekmiyor | — | — | Önerilmiyor: HEVC masum; H.264 yazılım yedeği **5× bellek** yer |

**Beklenen sonuç (hepsi uygulanırsa, tahmin):** akış sırasında GPU süreci ~410–480 MB, toplam WebView2 ~750–850 MB (şimdi 1,2–1,7 GB); pencere yokken ~100–130 MB (şimdi ~500–800).

### Hedef (öneri)
- Akış varken (tek 1080p60 pencere): toplam WebView2 **≤ 850 MB**.
- Son pencere kapandıktan 60 sn sonra: **≤ 150 MB**.

---

## 6) Sizden beklenen kararlar

1. **P0 + P1'i uygulayayım mı?** İkisi de düşük riskli; P1 görünümü değiştirmiyor. (Çalışan dev uygulamanızı HMR ile yeniden yüklediği için sizi bekledim.)
2. **P2'yi (ucuz ambient + küçük gölge) göz değerlendirmesi için bir dallanmış sürümde deneyelim mi?**
3. **P3 (keskinleştirme, cam efekti)**: bellek mi, görsel kalite mi? Varsayılan kalsın, ayar olarak sunulsun mu?

---

## 7) Yöntem ve sınırlar

- Süreç belleği `psutil` (USS/RSS), GPU belleği Windows `\GPU Process Memory` sayaçları (pid eşleşmesi joker olduğundan "shared" sütunu bazı ölçümlerde güvenilmez; kararları USS'ye dayandırdım), Chromium dökümü CDP `Tracing` (memory-infra), JS bellek `Performance.getMetrics`.
- Laboratuvar Edge (WebView2 ile aynı Chromium 155) üzerinde yürüdü; P0 ölçümü **gerçek Tauri/WebView2** derlemesinde.
- Telefon: yalnızca kısa süreli test pencereleri (Ayarlar uygulaması), en yüksek sıcaklık **40,0 °C** (başlangıç 37 °C; 41 °C'de otomatik duracak şekilde korumalı; sonra soğumasını bekledim). Sonsuz döngü yok. YouTube pencerenize dokunulmadı, ayar değiştirilmedi.
- Deney artıkları (ikinci vite sunucusu, Edge profilleri, Rust deneme kopyası) temizlendi. Telefonda yalnızca benim açtığım **bir Chrome test sekmesi** (`odx-anim-lab`) kalmış olabilir (DevTools soketine ulaşamadığım için kapatamadım) — görürseniz kapatın.

## 8) Kaynaklar

- WebView2 performans rehberi: <https://learn.microsoft.com/microsoft-edge/webview2/concepts/performance>
- `MemoryUsageTargetLevel`: <https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.memoryusagetargetlevel> · `TrySuspendAsync`: <https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.trysuspendasync>
- Tauri/wry `set_memory_usage_level`: <https://v2.tauri.app/release/wry/v0.35.0/>
- Canvas'ı atmadan önce sıfırlama (Chromium graphics-dev): <https://groups.google.com/a/chromium.org/g/graphics-dev/c/-0v7NwYq2-s> · GPU belleği geç iade: <https://issues.chromium.org/issues/40293940>
- `backdrop-filter` ile 400+ MB GPU: <https://github.com/theagenticage/hercule/issues/301>
- WebCodecs kare ömrü ve havuz: <https://www.w3.org/2021/03/media-production-workshop/talks/slides/paul-adenot-webcodecs-performance/> · <https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Using_the_WebCodecs_API> · <https://github.com/w3c/webcodecs/discussions/680>
- WebView2 + HEVC çözücü yolu: <https://github.com/MicrosoftEdge/WebView2Feedback/issues/5755>
- Tauri bellek karşılaştırması: <https://github.com/tauri-apps/tauri/issues/5889> · WebView2 bellek yönetimi: <https://github.com/MicrosoftEdge/WebView2Feedback/issues/799>

## 9) Yeniden üretme (scratchpad `…/scratchpad/lab/`)

`lab_matrix.py` (taze süreç matrisi, §3-C), `codec_run.py` + `codec_lab.html` (sade sayfa, §3-B), `lab_spike.py` (gerçek WebView2 `Low` testi, §3-D), `record_hevc.py` (gerçek HEVC akışı kaydı), `lab_release.py` (kapanış + basınç sinyali). Sonuç dosyaları: `matrix*_results.json`, `codec_results*.json`.
