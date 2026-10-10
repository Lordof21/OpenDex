# Telefona Aktar (handoff) — Gecikmesiz ve State Kaybı Olmayan Geçiş: Araştırma

Tarih: 2026-10-10 · Kapsam: `handoff_manager.py`, `task_movement.py`, `task_windowing.py`, `density_reconciler.py`,
`OpenDexDaemon.java` (WCT / restart), scrcpy `NewDisplayCapture.java`, bugünkü cihaz logu (`backend/logs/opendex-20261010.log`)
+ Samsung / Android / AOSP / Huawei-HarmonyOS kaynakları. **Kod değişikliği yapılmadı**; yalnızca bulgu + öneri.

---

## 1. Önce dürüst bir düzeltme: "Samsung/Huawei sıfır gecikmeyle aktarıyor" iddiasını doğrulayamadım

Bulabildiğim kaynaklar bunun tersini söylüyor:

* Samsung kendi geliştirici dokümanında mobil ⇄ DeX geçişini **runtime configuration change** olarak tanımlıyor
  (density, çözünürlük, yönelim, screenLayout, screenSize, smallestScreenSize, uiMode) ve "uygulamanın yeniden
  başlatılmasına zorlanabilir" diyor. 2017 tarihli Samsung blogu: varsayılanda uygulamalar mod geçişinde **öldürülür**
  ("Home'a basmak gibi").
* One UI 8'de "Diğer ekrana gönder" menüsü var; çalışan bir uygulamanın **kayıpsız** taşındığını doğrulayan hiçbir
  kaynak yok. Samsung topluluğunda eski sürümler için "çalışan pencereyi telefon ⇄ monitör arasında taşıyamıyorum"
  şikâyeti var.
* Huawei Desktop Mode dokümanı telefon ve büyük ekranın **bağımsız** çalıştığını, uygulamanın ikon uzun-basışıyla
  büyük ekranda *açıldığını* söylüyor; çalışan görevi canlı taşıma diye bir şey anlatmıyor.
* HarmonyOS "application continuation" ise canlı görev taşımak değil: kaynak tarafta `onContinue(wantParam)` ile
  **uygulamanın kendi serileştirdiği state** hedef cihazda `onCreate`'te geri yükleniyor. Yani uygulama işbirliği yapıyor.

Yani "sorunsuz" görünen şey sihir değil; üç şeyin toplamı:

| # | Mekanizma | Kaynak |
|---|-----------|--------|
| 1 | **Süreç öldürülmez.** Samsung manifest meta-data'sı (`com.samsung.android.multidisplay.keep_process_alive`, eski adı `keepalive.density`) geçişte süreci ayakta tutar. | developer.samsung.com/samsung-dex/modify-optimizing |
| 2 | **Config değişimi uygulamaya yerinde iletilir.** `configChanges="orientation\|screenSize\|smallestScreenSize\|density\|screenLayout\|uiMode…"` olan activity yeniden kurulmaz, `onConfigurationChanged()` çağrılır. Olmayan activity süreç içinde `relaunch` edilir (savedInstanceState ile, rotasyon gibi, yüzlerce ms). | Samsung + developer.android.com/…/support-connected-displays |
| 3 | **Uygulama ekranlar arası taşınmaya hazır yazılmış** (resizeable, responsive, dp). | aynı |

Android'in resmi dokümanı da aynısını söylüyor: ikinci ekrana taşınan activity "context update, window resize,
configuration and resource changes" yaşar; config'i kendisi karşılamıyorsa **relaunch** edilir; uygulama UI state'i
kaydetmelidir.

**Sonuç:** Hedef "hiç yeniden kurulma olmasın" değil, **"en hafif geçerli kademede kal, süreci asla gereksiz öldürme"**.

---

## 2. AOSP'nin kendisi ne yapıyor? (bizim durumumuzun resmi karşılığı)

* Temmuz 2025 AOSP commit'i **"Implement auto-restart on display move"**
  (`d415156531d9`, bayrak `com.android.window.flags.enable_auto_restart_on_display_move`, bug 427878712): *"Some apps
  cache display density outside the activity lifecycle, so the value isn't refreshed after they move to another
  display"* → Google bile, **yalnız bu tür uygulamalar için**, per-app override ile süreç yeniden başlatmayı
  seçiyor. Tüm uygulamalar için değil.
* `ActivityRecord.restartProcessIfVisible()` (SizeCompat "Restart" düğmesinin kullandığı) interface yorumuna göre
  *"Restarts the activity by killing its process if it is visible"*. Yani **süreci öldürür**.
  (Kaynak kodunu satır satır okuyamadım — googlesource/gerrit aynası erişilemedi; ama aşağıdaki cihaz logu bunu
  bağımsız olarak doğruluyor.)
* Android 16: `CONFIG_ASSETS_PATHS` / `CONFIG_RESOURCES_UNUSED` ile uygulamalar **tüm** config değişimlerini
  kendileri karşılayabilir — relaunch tamamen kapanabilir (bizim reconciler "Android 16 opt-out" dalıyla zaten uyumlu).

---

## 3. Bizim koddaki asıl bulgular (cihaz logu ile doğrulandı)

### 3.1 🔴 Her aktarımda süreç ÖLDÜRÜLÜYOR (state kaybı kaynağı)

`handoff_manager.py:508-518` — adım 3 "View Ağacı Re-Inflate": taşımadan sonra **koşulsuz**
`daemon.restart_task_activity(task_id)` çağrılıyor. Bu, `ITaskOrganizerController.restartTaskTopActivityProcessIfVisible`
= SizeCompat "Restart" = **süreç yeniden doğumu**. `device_daemon_client.py:831` docstring'i ("~30 ms, süreci
öldürmeden, state/backstack kaybı olmadan") **yanlış**.

Log kanıtı (bugün, Chrome, aynı pencere; her satır bir `density_reconciler` SONUÇ'unun pid'i):

```
16:57:58  pre_landing  pid 11208  (aktarım #1 → REINFLATE 16:57:59)
16:58:13  reclaim      pid 11815  ← süreç değişti
16:58:42  pre_landing  pid 11815  (aktarım #2 → REINFLATE 16:58:43)
16:58:53  reclaim      pid 12278  ← yine değişti
16:59:18  pre_landing  pid 16537  (aktarım #3 → REINFLATE 16:59:19)
16:59:31  reclaim      pid 17398  ← yine değişti
```

Her aktarımdan sonra pid değişiyor: **uygulama her seferinde ölüp yeniden doğuyor**. Chrome bunu "iyi" taşıyor
(sekmeleri geri yüklüyor); ama oynayan video konumu, oyun, görüşme, indirme, process-içi önbellek, bellekteki
form/kaydedilmemiş düzenleme, WebSocket oturumu gibi her şey gider. Bu, hedefinizle ("state kaybı olmadan") doğrudan çelişiyor.

Üstelik gereksiz: aynı logda ön-iniş (pre-landing) zaten kanıtlamış:

```
16:57:58.117 [DENSITY] com.android.chrome (pre_landing): uygulama son yoğunluk değişiminden SONRA kendini yeniden kurdu
             (pid 11208 recreated …Main) — ek yenileme yapılmadı   →  adapted, pid 11208 → 11208
```

Yani uygulama perdenin arkasında **süreci öldürmeden** doğru yoğunluğa uyum sağlamış, taşıma yoğunluk-nötr; yine de
1 sn sonra süreç öldürülüyor. `density_reconciler.py`'nin tüm tasarımı ("kanıtsız dokunma; en hafif kademe önce;
süreç yeniden başlatma son çare") handoff adım 3 tarafından fiilen yok sayılıyor. `restarted == True` olunca ayrıca
`schedule_settle` da atlanıyor (satır 523-530), yani kanıt zinciri de kapanıyor.

### 3.2 🟠 Gecikmenin yarısı sabit bir `sleep`

Bugünkü logdan bir aktarımın zaman çizelgesi (`57.589` başlangıç → `59.226` perde kalkışı; FE ölçümü `1684 ms`):

| Adım | Süre |
|------|------|
| `KEYCODE_WAKEUP` + `wm dismiss-keyguard` (ardışık) | ~0,12 sn |
| snapshot (`pidof` + `/proc/stat`) + `OPENDEX_RESIZE` (boyut+DPI tek adım) | ~0,25 sn |
| reconciler kanıtı (`adapted`) | ~0,13 sn |
| **`HANDOFF_PRELANDING_STABILIZE_S = 0.8` sabit bekleme** | **~0,79 sn** |
| WCT taşıma | ~0,12 sn |
| `am start --display 0 … LAUNCHER` | ~0,10 sn |
| `restart_task_activity` + `wm size` + windowing doğrulama | ~0,09 sn |

Sabit 0,8 sn, kanıt `adapted` olarak geldikten (0,13 sn) sonra bile bekleniyor. Yorumdaki gerekçe doğru (yeni render
sürecinin ilk karesi), ama bu bir **zaman** değil bir **olay**: ilk kare/`onResume` gelince devam edilebilir.

### 3.3 🟡 Taşımadan sonraki `am start … LAUNCHER` gereksiz ve riskli

WCT zaten `reorder(top)` + `setFocusable` yapıyor. Logda `device_tasks_update` taşımadan 0,09 sn sonra görevi
`display 0, visible: True` gösteriyor — `am start` çıktısı ondan sonra geliyor. LAUNCHER intent'i mevcut göreve
`onNewIntent` olarak teslim olabilir (singleTop/singleTask uygulamalarda kök ekrana dönüş, arama kutusu sıfırlama gibi
state kayıpları mümkün). Görev görünür değilse yedek olarak kalmalı; varsayılan yol olmamalı.

### 3.4 🟢 Doğru gidenler (dokunulmamalı)

* Ön-iniş (VD'yi telefonun boyutu+DPI'ına PC perdesi arkasında tek atomik `OPENDEX_RESIZE` ile çekmek) — Samsung'un
  "config değişimi görünmeden yaşansın" fikrinin karşılığı; log doğruluyor (Chrome kendi kendine uyum sağladı).
* WCT tek-atomik `reparent + windowingMode + bounds + setDensityDpi(0) + reorder` — AOSP'nin önerdiği yol, Tier'li.
* Süreç kimliği (pid + `/proc` start time) ile kanıtlı `adapted` kararı — "dokunma" kararının doğru zemini.
* Aktarım penceresi `hold()` korumaları ve `_active_transitions` — yarış koşulları kapalı.

---

## 4. Öneriler (etki sırasına göre)

> **Düzeltme (kullanıcı geri bildirimi, 2026-10-10):** Chrome tablet boyutundan telefona gelince yoğunluğu doğru
> uyguluyor ama eski yazı boyutları (önbellek) bozuk kalıyor; yani `adapted` kanıtı (activity yeniden kuruldu) Chrome için
> **görsel uyumu kanıtlamıyor**. Adım 3 muhtemelen bu yüzden eklendi. Aşağıdaki P0 bu haliyle Chrome'da regresyon
> yapar; önce bayat katmanı teşhis edin (bkz. §6), P0'ı "sil" değil "**restart'ı perde arkasına taşı + kanıta bağla**" olarak uygulayın.

### P0 — Handoff adım 3'ü kanıta bağla / kaldır (state kaybını bitirir)
`_execute_to_phone` içinde `restart_task_activity` çağrısını **sil**; yoğunluk işini yalnızca `density_reconciler`
yapsın (zaten `schedule_settle` var):
* `prelanded == True` → hiçbir şey (taşıma nötr, uygulama kanıtlı uyum sağladı).
* `prelanded == False` → `density_before` ile `schedule_settle` (taşıma sonrası, arka planda): adapted → dokunma;
  değilse kademe merdiveni (in-place relaunch → locale nudge → **son çare** süreç yeniden başlatma).
* `device_daemon_client.restart_task_activity` docstring'ini düzelt (süreci öldürür).
* Test: `test_handoff_manager.py:383` (`reinflate…`) beklentisini "ön-iniş yoksa settle zamanlanır, restart çağrılmaz"
  olarak değiştir.
Beklenen kazanç: pid sabit kalır, gecikme ~0,1 sn azalır, `schedule_settle` yeniden devreye girer.

### P1 — Sabit 0,8 sn beklemeyi olay-tabanlı yap
`HANDOFF_PRELANDING_STABILIZE_S`'yi **üst sınır** yap; asıl bekleme: yeniden kurulan activity'nin `wm_on_resume_called`
(reconciler zaten bu event günlüğünü okuyor) + ~1 kare. `adapted` kanıtı "kendini yeniden kurdu" ise o event'in
zaman damgası zaten elde. Hedef: tipik aktarım ~1,0 sn → ~0,4–0,5 sn. *Not: cihazda ölçmeden değer seçme; Chrome'un
yeni render süreci vakası için üst sınır kalsın.*

### P2 — `am start LAUNCHER`'ı yedek yap
WCT sonrası `get_task_geometry(...).visible` (daemon, ~2 ms) doğruysa `bring_to_front` çağrılmasın. `onNewIntent`
kaynaklı state kayıplarını ve ~0,1 sn'yi kaldırır. (`settle_task_windowing` zaten `skip_if_ok` mantığıyla çalışıyor.)

### P3 — Küçük paralelleştirmeler
* `wake_and_unlock` ikisini `asyncio.gather` ile; ayrıca pre-landing ile eşzamanlı başlat (~0,12 sn).
* `phone_density` + `phone_size` okumalarını `gather` ile (şu an ardışık).

### P4 — Süreç ölümü kaçınılmaz olduğunda state'i sigortala (opsiyonel)
Merdivenin son basamağı (süreç yeniden başlatma) çalışacaksa, öncesinde daemon `MediaBridge` ile aktif MediaSession'ın
(çalıyor mu, konum) anlık görüntüsünü al, sonrasında `seek + play` uygula (density state memory notundaki
`media_action play` altyapısı hazır). Süreç ölümünde `onSaveInstanceState` çalışır mı sorusunu AOSP kaynağından
doğrulayamadım — cihazda `logcat -b events` (`wm_stop_activity`, `wm_destroy_activity`) ile bir kez teyit edin.

### P5 — Yapısal seçenek: "Süreklilik kipi" pencere (ödünleşimli, ayrı karar)
Android'de **config farkı yoksa relaunch da yoktur.** VD'yi pencere açılırken telefonun boyutu+DPI'ında tutan bir
pencere türü (PC'de telefon-düzeninde, ölçeklenmiş akış) aktarımı saf `reparent` yapar: sıfır yeniden kurulma, sıfır
state kaybı. Bedeli: PC penceresi masaüstü düzeni (geniş/tablet layout) veremez. Pencere başına tercih olarak
sunulabilir; zaten `needs_dp` (|window_dp − phone_dp| ≤ 16) bu yönde bir eşik taşıyor — bugünkü logda pencere 383 dp,
telefon 381 dp, yani bu kullanıcı için fiilen sadece **yoğunluk** değişiyor.

---

## 5. Doğrulama planı (cihazda, kod değişikliğinden sonra)
1. Aynı log analizi: art arda 3 aktarım+geri alma → `[DENSITY] SONUÇ … pid A → A` ve **aktarımlar arası pid sabit**.
2. YouTube (videonun konumu), bir not uygulaması (kaydedilmemiş metin), bir oyun: aktarım öncesi/sonrası state.
3. `FE:handoff to_phone_done ms` — bugünkü taban 1684 ms.
4. `adb logcat -b events | grep -E "wm_relaunch|wm_on_(create|destroy)|wm_restart|wm_stop"` — hangi kademe çalıştı.
5. Regresyon: YouTube/React Native gibi "yoğunluğu önbelleğe alan" uygulamalarda yoğunluk hâlâ doğru mu (P0 bunları
   reconciler merdivenine bırakıyor; burada başarısızlık görülürse restart yalnızca `adapted` olmayan vakada çalışmalı).

---

## Kaynaklar
* Samsung — Optimizing your app (DeX config changes, keepalive, configChanges): https://developer.samsung.com/samsung-dex/modify-optimizing
* Samsung — Lifecycle on switching between Mobile and DeX: https://developer.samsung.com/sdp/blog/en/2017/12/07/samsung-dex-lifecycle-on-switching-between-mobile-and-samsung-dex-mode
* Samsung forum — Phone to DeX without app restart: https://forum.developer.samsung.com/t/phone-to-dex-without-a-app-restart/17885
* Samsung — DeX FAQ (One UI 8 "Send to other display"): https://www.samsung.com/us/support/answer/ANS10001972/
* Android — Support connected displays: https://developer.android.com/develop/adaptive-apps/guides/support-connected-displays
* AOSP — "Implement auto-restart on display move" (d415156531d9): https://android.googlesource.com/platform/frameworks/base/+/d415156531d9
* AOSP aynası — "Don't restart processes that host visible activities": https://gerrit.omnirom.org/plugins/gitiles/android_frameworks_base/+/efdc32ca04965640d5308ae165f4a5935bc7f888%5E2
* AOSP aynası — Allow Activities to handle configuration changes (CONFIG_ASSETS_PATHS/RESOURCES_UNUSED): https://gerrit.omnirom.org/plugins/gitiles/android_frameworks_base/+/7de701f808a27490c464b65b1ccb3d3a9de046e9%5E%21
* Android — Large screen compat (size compat restart "recreates the app process"): https://source.android.com/docs/core/display/large-screen/setup-guide
* Huawei — Desktop Mode: https://consumer.huawei.com/uk/support/content/en-gb15919107
* OpenHarmony — UIAbility.onContinue / continuation: https://gitcode.com/openharmony/docs/blob/OpenHarmony-5.0.2-Release/en/application-dev/reference/apis-ability-kit/js-apis-app-ability-uiAbility.md

---

## 6. Ek (2026-10-10): "Yoğunluk doğru ama yazı boyutları bayat" — Chrome vakası

**SurfaceFlinger'dan yeniden render istemek işe yaramaz.** SF yalnızca uygulamanın ürettiği buffer'ları birleştirir
(compose); yazı boyutu/layout uygulamanın UI/RenderThread'inde (Chrome'da ayrıca renderer sürecinde) hesaplanır. SF'yi
tetiklemek eski buffer'ı yeniden basar, yeni ölçüm üretmez. Uygulamayı yeniden ölçtürebilen tek yasal tetikleyiciler
uygulama tarafındadır: config değişimi (density/screenSize/fontScale/locale), pencere boyutu değişimi (relayout),
görünürlük (stop/start), activity relaunch, süreç yeniden doğumu. (Genel mimari bilgisi; arama bunu doğrudan doğrulamadı.)
`surfaceflinger_probe.py` zaten yalnızca teşhis amaçlı.

**Teşhis (5 dk, kod gerektirmez) — hangi katman bayat?** Aktarımdan sonra, Chrome telefondayken:
1. `adb forward tcp:9222 localabstract:chrome_devtools_remote` → `http://localhost:9222/json` → sekmede
   `navigator.userAgent`, `innerWidth`, `devicePixelRatio` (beklenen ≈ 513/160 = 3,2), `visualViewport.scale`.
2. UA "Linux x86_64"/masaüstü ve `innerWidth` ≈ 980+ → **H1: masaüstü-site modu takılı kaldı** (Chrome büyük tabletlerde
   masaüstü UA + pencere genişliğinde viewport'u varsayılan açıyor — developer.chrome.com/blog/desktop-mode; telefona
   düşünce sekme yeniden yüklenmiyor, süreç yeniden doğunca sekme mobil UA ile yükleniyor). Süreç öldürmek bunu
   *dolaylı* çözer.
3. UA mobil ama `devicePixelRatio` eski → **H2: renderer DSF/viewport önbelleği**.
4. Web içeriği doğru, yalnız Chrome arayüzü (araç çubuğu) bayat → **H3: native UI Resources önbelleği**.

**Seçenekler (paket adı yok):**
* H3/H2 için: perde arkasında boyut-nudge (VD'yi ±1 px oynat → ek screenSize config + relayout; ~0,17 sn × 2) — ucuz,
  kanıtı belirsiz; H1'i çözmez.
* Sınıf sınırı kuralı: taşıma bir pencere-sınıfı sınırını (Android WindowSizeClass: 600 dp / 840 dp) geçiyorsa
  (tablet→telefon) kanıt `adapted` olsa bile sert kademe **ön-iniş içinde, perde arkasında** çalışsın. Genel ve ilkeli,
  ama sınırı geçen her uygulama süreç kaybeder → öğrenme ile birleştirin.
* Öğrenilen bayrak: kullanıcı "görünüm bozuk → Yenile" derse (süreç yeniden başlatma) paket `DeviceProfile`'a işlenir
  (`density_inplace_relaunch` ile aynı desen); sonraki aktarımlarda o paket için sert kademe perde arkasında koşar.
  Elle kodlanmış paket listesi yok, ama yalnız kullanıcının bozuk dediği uygulamalar süreç kaybeder.
* Sert kademeyi ne olursa olsun **telefonda değil VD'de (perde arkasında)** çalıştırın: eski bir revizyonda
  ("ÖN-İNİŞ VIEW RE-INFLATE", 2026-10-10 00:00 logu) böyleydi; şimdiki kod restart'ı taşımadan SONRA, telefonda
  görünür halde yapıyor.

### 6.1 Netleştirme: bayat olan Chrome değil, SAYFA (web içeriği)
Kullanıcı: sorun Chrome'da değil, içindeki sitelerin önbellekten/yükleme-anı kararlarından yararlanması. Bu durumda
yoğunluk/config değişimi sayfanın yeniden düzenlenmesini garanti etmez: site düzenini **yükleme anında** seçer (UA /
Client Hints / viewport meta / JS'in bir kez okuduğu `innerWidth`, `matchMedia`, localStorage'daki "mobil mi" kararı,
önbellekten gelen masaüstü HTML'i) ve Blink'in yazı otomatik ölçeklemesi ilk layout'ta hesaplanır. Çözen şey **sayfa
yeniden yükleme**; süreç öldürmek yalnızca Chrome sekmeleri geri yüklerken sayfaları yeniden yüklediği için dolaylı çözüyor
(ve tüm sekmeleri + süreç state'ini götürüyor).

Öneri: **süreç yerine sayfa yenile** — Chromium-tabanlı içerik (Chrome, Edge, Brave, WebView'lı uygulamalar) için
DevTools soketi üzerinden (`/proc/net/unix` içinde `*_devtools_remote`; paket adı kodlanmaz, davranıştan tespit):
1. Ön-iniş içinde, taşımadan ÖNCE (perde arkasında, VD zaten telefon boyutunda/DPI'ında): her sayfa hedefinde
   `Runtime.evaluate` ile `innerWidth`, `devicePixelRatio` oku → beklenen `innerWidth ≈ ekran_px / dpr` (≈ 380 css px),
   `dpr ≈ dpi/160`. Uyuşuyorsa dokunma (kanıt); uyuşmuyorsa `Page.reload` (gerekirse `ignoreCache`), `loadEventFired` +
   ~üst sınır 2 sn bekle, tekrar ölç. Bu, sabit 0,8 sn beklemenin yerine geçer ve görsel uyum için **gerçek kanıt** verir.
2. Sertleşme: reload sonrası hâlâ uyuşmuyorsa (ör. Chrome'un tab-başına masaüstü-site kipi) sert kademe (süreç yeniden
   başlatma) — yine perde arkasında.
3. DevTools soketi yoksa (Firefox, Samsung Internet, kapalı uzaktan hata ayıklama) yedek: tarayıcıya F5/Ctrl+R enjekte
   etmek (scrcpy kontrol kanalı) — yalnızca DevTools/tarayıcı rolü tespit edilmiş uygulamalara.
Doğrulanmadı / cihazda denenmeli: shell kimliğinin (daemon) soketlere bağlanabilmesi, Chrome'un masaüstü-site kipinin
CDP reload ile sıfırlanıp sıfırlanmadığı. Bu düzeltme P0'ın "restart'ı kaldır"ının güvenli yoludur.

### 6.2 Cihaz ölçümü (2026-10-10 17:41–17:48, DevTools soketi, Chrome 154)
* Soket erişimi: shell kimliği `@chrome_devtools_remote`'a bağlanıyor; yalnız ÖNDEKİ sekme yanıt veriyor (arka plan dondurulmuş).
* UA tablet pencerede de mobil kaldı → "masaüstü-site modu" hipotezi (H1) çürüdü.
* Bayat durum yakalandı (iki kez, aynı): taşımadan sonra, restart etkisini göstermeden önce `innerWidth 317 / dpr 3.848`
  (doğrusu 380 / 3.206); oran 3.848/3.206 = **1.2000** (Chrome yakınlaştırma basamağı 1.2^n). Tablet pencerede de
  `dpr 1.35 = 1.125 × 1.2` (180 dpi pencere), küçük pencerede (215 dpi) `dpr 1.344 = 1.344 × 1.0`. Yani Chrome geniş
  yapılandırmada sayfa ölçeğini ×1.2 yapıyor, dar yapılandırmaya dönünce **süreç içinde geri almıyor** (config.py'deki
  `DENSITY_SELF_RECREATE_ESCALATE` açıklamasıyla birebir uyumlu). Bayat pencere ~3,6 sn sürüyor (restart: stop→state→kill).
* `Page.reload` bayat ölçeği düzeltmedi (+0,33 sn'de hâlâ 3.848, `loading`), ama süreç ~1,4 sn'de öldüğü için
  **kesin değil**; "sayfa yenile" önerisi kanıtlanmadı, geri çekildi.
* Olası kaynak (doğrulanmadı): Chrome "Accessibility Page Zoom" — varsayılan yakınlaştırma OS ayarlarına göre hesaplanıyor
  (blink-dev duyurusu); bu hesap yalnız bazı olaylarda yeniden yapılıyor olabilir.
* Kodda `_WEB_RENDER_PACKAGES` + alt-dize eşleşmesi (`"chrome"`, `"browser"`) var: `com.google.android.apps.chromecast.app`
  gibi paketleri de yakalar. Ölçüme dayalı tespit (devtools soketi + `dpr` sapması) hem yanlış pozitifleri hem ×1.0 durumdaki
  gereksiz süreç öldürmeyi (küçük pencere → telefon) önler.
