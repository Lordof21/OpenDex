# Workspace penceresi telefondaki orta tuş / yukarı jestinde mini pencereye düşüyor (0,2269)

Tarih: 2026-10-28 · Durum: yalnız araştırma + rapor, kodda değişiklik YOK.
Sınır: araştırma sırasında telefon bağlı değildi (`adb devices` boş) → canlı `dumpsys` / SurfaceFlinger okuması yapılamadı.
Aşağıdaki her madde "KANIT" (günlük/koddan okundu) ya da "ÇIKARIM" (cihazda doğrulanmadı) diye işaretli.

## 1. Ne oluyor (KANIT — `backend/logs/opendex-20261027.log`, 23:44:40 → 23:44:54)

| an | okuma | anlamı |
|---|---|---|
| 23:44:40.6 | WM `(374,77,1718,1070)` freeform, SF `(374,77,1315,772)` ölçek **0,70** | sağlıklı |
| 40.6 → 45.9 | OpenDeX hiçbir komut göndermiyor (yalnız video pompası) | tetik PC tarafında değil |
| 45.98 | arayüz aynı kutuyu yeniden istiyor, `task resize` aynı değerlerle | — |
| 46.35 | WM hâlâ `mode=freeform`, bounds **aynı**, görünür | WindowManager mini'den habersiz |
| 46.75 | SF yüzeyi `(374,77,679,302)` = 305×225 = 1344×993 × **0,2269** | pencere katmanına mini dönüşümü bindi |
| 46.8 → 54 | WS-GUARD 3 tur "küçülmüş" diye onarmaya çalışıyor, her seferinde `verdict=ok` ama SF ölçeği 0,23 kalıyor | onarım yanlış şeye bakıyor |

Sonuç: HyperOS'un mini/yüzen pencere durumu **WindowManager'da görünmüyor** (kip, bounds, `visible` değişmiyor). Tek iz SurfaceFlinger'daki
görev/pencere katmanının `toDisplayTransform` ölçeği. `cmd activity task resize` bu ölçeği silmiyor: kutuyu değiştiriyor, ama 0,2269 ile
çarpılmış çiziliyor (46.8–54 arası SF kutuları buna uyuyor).

## 2. Neden oluyor

- Tetik: telefonda orta tuş / yukarı jest (kullanıcı tarifi; koddaki 2026-10-27 yorumu da aynı: `eco_workspace.py:646`). KANIT: OpenDeX'in
  kendi Home'u (`unlock_display0_gesture_navigation`) yalnız `--display 0` launcher'ı açıyor, sanal ekrana dokunmuyor → o da tetik değil.
- Neden sanal ekrandaki (display 42) pencereyi etkiliyor: ÇIKARIM. HyperOS'un freeform denetleyicisi jesti "odaktaki freeform görev"e
  uyguluyor ve ekranına bakmıyor; PC'den dokunuş enjekte edildiğinde odaktaki ekran sanal ekran oluyor. Telefonda launcher göründüğü
  halde freeform görev hâlâ "odakta" olduğu için jest ona uygulanıyor. Doğrulama: jest sırasında `dumpsys window | grep -i focus`.
- 0,2269 sabit bir HyperOS mini ölçeği (iki ayrı cihaz okumasında da aynı).

## 3. Mevcut kod bunu nasıl karşılıyor, neden yetmiyor

1. `_get_task_effective_bounds` (`eco_workspace.py:629`): SF ölçeği cihazınkinden belirgin farklıysa "pencere gerçekten öyle çiziliyor" deyip
   SF'nin (kutu, ölçek) çiftini defterde kabul ediyor (testi: `test_freeform_scale.py::test_a_mini_window_is_taken_from_surfaceflinger…`).
   Yani mini durum **kabul ediliyor, geri alınmıyor** → arayüzde çerçeve 305×225'e iniyor; kullanıcının gördüğü "0,22'ye düştü" bu.
2. `verify_member` / `collapse_reason` (`eco_workspace.py:184`): yalnız WM'ye bakıyor (kip, `visible`, bounds alanı). Mini'de üçü de normal →
   "ok" dönüyor. Üstelik defter kutusu mini ölçeğiyle bozulmuşsa `_ledger_box_plausible` ile "bilinmiyor" diyor, onarmıyor.
3. Her `resize_task` (`:1064`) `task.render_scale` ile dönüştürüyor: mini'deyken 0,2269 → Android kutusu ~3,1× büyük. 23:44'te dört turda
   106450×76112 px'e çıktı; bugün `_ledger_box_plausible` bunu keser ama pencere yine mini kalır.
4. Aygıt ölçeği zehirlenme riski (kod okuması, gözlenmedi): `_remember_measured_scale` düşük okumayı **iki ardışık okuma** teyit ederse kalıcı
   `DeviceProfile.freeform_scale`'e yazıyor (`next_freeform_scale`). Mini'de SF her okumada 0,2269 verir → iki okuma sonra cihazın ölçeği
   0,2269 olarak diske yazılır ve sonraki oturumlarda her yerleşim yanlış başlar. (0,57 vakası gerçek: kutu ekrandan büyükken sistem
   gerçekten küçültüyor; mini ile ayrım: 0,57/0,70 = 0,81, mini 0,2269/0,70 = 0,32.)

## 4. Önleme seçenekleri

| | yol | artı | eksi |
|---|---|---|---|
| A | HyperOS'un "freeform'u yukarı kaydırarak küçült" ayarını kapat (`settings list global/secure/system \| grep -i freeform`, "Yüzen pencereler" ayar sayfası) | tek seferlik, kök neden | anahtar adı bilinmiyor (cihazda aranacak), telefon ayarını değiştirir (önceki deneyde bunun için onay alındı) |
| B | Jest anında odağı sanal ekrandaki freeform'dan çekmek | — | jesti önceden bilemeyiz; PC dokunuşu odağı zaten sanal ekrana alıyor → güvenilmez |
| C | Jesti engellemek (giriş yakalama) | — | sistem jesti, uygulama yakalayamaz → olmaz |
| D | **Tespit + anında geri al** (aşağıda) | cihaz ayarına dokunmaz, ROM'dan bağımsız kalır | geri alma yöntemi cihazda kanıtlanmalı |

Gerçekçi tek yol A (varsa) + D. A bulunamazsa D tek başına yeterli ve kullanıcı davranışına (yukarı jest) saygılı.

## 5. Geri alma ("resize olunca tekrar aktif") — önerilen tasarım

### 5.1 Mini'yi tanıma (tek yerde, saf fonksiyon)
`is_mini(sf_scale, device_scale, mode, visible)`: mod freeform ∧ görünür ∧ `sf_scale < 0.5 × device_scale` (0,32 mini / 0,81 büyük kutu →
0,5 güvenli eşik). Okuma: `surfaceflinger_probe.probe_omni_geometry` zaten `scale_measured` veriyor; tek SF dump ~ pahalı → sık yoklanmaz.

### 5.2 Ne zaman bakılır (ucuz tetikler)
1. **Her `resize_task`'ın başında** (istenen: "resize olunca yeniden aktifleştir"). Mini ise önce geri al, sonra cihaz ölçeğiyle (0,70) hesapla.
2. **`verify_member`** (kullanıcı çerçeveye bastığında) — şimdi WM'ye bakıyor, SF ölçeğini de okusun.
3. **Daemon odak olayı**: telefonda launcher öne gelince `TaskEvents.onTaskFocusChanged / broadcastFocusIfChanged` zaten push ediyor
   (`TaskEvents.java:118–131`). Odak display 0'a geçince Workspace açıksa **tek** SF kontrolü yapılır → kullanıcı jesti yaptığı anda pencere
   kendiliğinden geri gelir, resize beklemek gerekmez. (ÇIKARIM: mini'nin kendisi stack olayı vermiyor; odak değişimi vermesi beklenir —
   doğrulanacak, §7.)

### 5.3 Geri alma merdiveni (ucuzdan pahalıya, her basamaktan sonra SF ile doğrula)
1. **Yeniden yerleştir + öne al:** `freeform_start_command(vd, component, launch_bounds)` ( `--windowingMode 5 --activity-reorder-to-front`)
   — açılışta kullanılan, MIUI'nin kendi giriş yolunu (miuiFreeformTaskInfo) çalıştırır. En az yan etki.
2. **Kip döngüsü:** `am start --display <vd> --windowingMode 1` → 1 sn → `--windowingMode 5` + `task resize`. Aynı mantıkla 2026-10-13'te bayat
   0,7 dönüşümü temizledi (`task_windowing.repair_stale_render_transform`, ölçüldü: yalnız bu döngü temizledi). Mini'de denenmedi.
3. **WCT:** daemon `set_task_windowing(FULLSCREEN)` sonra `FREEFORM + kutu` (`_apply_mode`). Etkinlik yeniden kurulmaz ama
   `handoff_manager.py:519` notu: WCT ile freeform'a alınan görevde `miuiFreeformTaskInfo` oluşmuyor → mini durumunu temizlemeyebilir.
4. **Vendor API** (daemon'da yansıtma ile `MiuiFreeFormManager` "mini'den çık"): mini pencereye dokunmanın yaptığı iş; adı/imzası cihazdan
   çıkarılmadan yazılamaz. Merdiven 1–3 tutmazsa araştırılır.

Her basamak ardından: `probe_omni_geometry` ölçeği ≈ cihaz ölçeği mi? Evetse defter kutusunu **eski (mini'den önceki) kutuya** döndür, `workspace_task_bounds_changed` yay.
2 turda geçmiyorsa pes et, kullanıcıya olay yay (`workspace_task_mini`), döngüye girme.

### 5.4 Defteri koru
- Mini okuması **asla** `_remember_measured_scale`'e ya da `task.bounds/render_scale`'e yazılmaz (şimdiki "tutarlı çift" kabulü mini için
  kaldırılır; yalnız sıradan küçülme — örn. 0,57 — kalır). Böylece cihaz ölçeği zehirlenmez, çerçeve arayüzde 305×225'e inmez.
- Mini sürerken arayüz çerçevesi son sağlıklı kutuda kalır (isteğe bağlı küçük rozet: "Pencere küçültüldü — yeniden etkinleştiriliyor").
- `test_freeform_scale.py::test_a_mini_window…` davranışı tersine döner → güncellenir.

## 6. İş planı (öneri)

| # | iş | dosya | risk |
|---|---|---|---|
| P0 | §7'deki cihaz ölçümleri (ayar anahtarı, mini'de WM/SF/logcat izi, hangi geri alma tutuyor) | — | yok |
| P1 | `is_mini` + defteri koru (§5.4) + eşik testleri | `eco_workspace.py`, `test_freeform_scale.py` | düşük |
| P2 | `resize_task` ve `verify_member` başında mini → geri al merdiveni | `eco_workspace.py`, `task_windowing.py` | orta (cihazda doğrulanmalı) |
| P3 | Odak olayında tek SF kontrolü (sanal ekranda Workspace açıkken, 1–2 sn debounce) | `window_manager.py` + daemon olay aboneliği | orta |
| P4 | A: ayar anahtarı bulunduysa Ayarlar → Sistem'de seçenek | FE + `android_shell` | düşük–orta |

P1 tek başına bile zararı keser (ölçek zehirlenmez, çerçeve küçülmez, resize patlamaz); P2 asıl "yeniden aktifleştirme"yi getirir.

## 7. Cihazda ölçülecekler (telefon bağlıyken, ~10 dk)

1. Workspace'te Chrome açık; mini'yi telefondaki jestle oluştur. Hemen: `adb shell dumpsys window windows | grep -i -E "freeform|mini|Task\{"`,
   `adb shell dumpsys SurfaceFlinger | grep -B2 -A6 "Task=<id>"`, `adb logcat -d -s ActivityTaskManager WindowManager MiuiFreeform:V | tail -200`.
   Beklenen: WM'de değişen alan var mı (varsa `collapse_reason` kullanılabilir), hangi sistem bileşeni (`MiuiFreeformModeController`…) log yazıyor.
2. Odak: jest sırasında ve sonrasında `adb shell dumpsys window | grep -E "mCurrentFocus|mFocusedApp|mTopFocusedDisplayId"` — §2 çıkarımı (odak sanal ekranda mı).
3. Ayar: `adb shell settings list global|secure|system | grep -i -E "freeform|float|small|mini"` önce / sonra (ayar sayfasında geçişi değiştirip farkı oku).
4. Merdivenin her basamağını elle dene (`am start … --windowingMode 5`; mod 1→5; daemon WCT) ve `dumpsys SurfaceFlinger` ölçeğini oku — hangisi 0,70'e döndürüyor.
5. Servis: `adb shell service list | grep -i -E "free|window|miui"` ve `dumpsys activity service` ile vendor "mini'den çık" çağrısı var mı.

## 8. Cihaz kaydı — Android tarafı fonksiyon ağacı (2026-10-28 20:40, KANIT)

Telefon kablosuz adb ile bağlandı (POCO 2412DPC0AG, HyperOS 3 / Android 16). Display 0'a freeform Chrome (task 2026) açıldı, kullanıcı mini yaptı ve
tıkladı; `logcat -b all` + perfetto (wm/am/view/input/gfx/ss/binder) + 0,8 sn'de bir SF/WM yoklayıcı kayıtta idi. İzleme için `miuifreeform` Shell
komutu ve `cmd window logging` grupları açıldı, iş bitince kapatıldı. Ham kayıt: scratchpad `…/scratchpad/mini/` (logcat_all.txt, mini.pftrace 268 MB,
snap/ dump'ları, timeline.log).

### 8.1 Mini'ye giriş (Home jesti → 0,25)

```
GestureStubHome dokunuşu (system_server InputDispatcher, "[Gesture Monitor] miui-gesture" + "WMShell")
└─ com.miui.home (pid 20889) NavStubView.onTouchEvent → getRunningTaskForGesture (çalışan görev = tam ekran ChatGPT t2027, Chrome DEĞİL)
   ├─ RecentsAndFSGestureUtils.canTaskEnterSmallWindow → true
   ├─ ActivityTaskManager.moveTaskToFront(Launcher t1930)  → Shell transition 1586 (TO_FRONT)
   └─ yayın  com.miui.fullscreen_state_change  {channelName=gesture}  stateName sırası:
        taskSnapshot → crossSafeArea → startControlAppWindow → toHome
com.android.systemui (pid 16266, "MiuiSystemUI")
└─ MiuiFreeformModeSettingsObserver.handleFreeFormReceiver
   └─ MiuiFreeformModeController.snapshotAllFreeform()                          (taskSnapshot)
   └─ MiuiFreeformModeController.allFreeformFromFreeformToMini()                (toHome)  ← KÖK: TÜM freeform görevleri (Chrome 2026, Claude 2029)
      ├─ MiuiMultiWindowUtils: "small freeform {width:305 scale:0.25}"          ← mini ölçeği buradan (0,25; 305 px genişlik; eski kayıtta 0,2269)
      ├─ setMiuiFreeformInfoChange(WCT, MiuiFreeFormInfoChange{windowState=0, freeFormScale=0.25})
      │     └─ system_server MiuiFreeFormManagerService.addFreeFormActivityStack / dispatchFreeFormStackModeChanged  (mMiuiFreeFromWindowMode = 1)
      ├─ MiuiFreeformModeTaskRepository.onTaskModeChanged (0→1)
      ├─ MiuiFreeformModeAnimation.applyFreeformToMiniAnimation   (anim tipi 11, ~0,7 sn)
      ├─ MiuiFreeformModeAvoidAlgorithm → applyMiuiFreeformAvoidAnimation (diğer mini pencereyi kaydırır, tip 12)
      └─ com.miui.home SmallWindowStateHelper.addMiniSmallWindowInfoSet(com.android.chrome)
```
Mini durumu WindowManager'da değil, **HyperOS'un kendi kaydında** (`MiuiFreeFormActivityStack.mMiuiFreeFromWindowMode`, SF'de pencere katmanı dönüşümü).
Bu yüzden `dumpsys activity`'de görev `mode=freeform visible=true` ve bounds aynı kalıyor; yalnız SF `toDisplayTransform` 0,70 → 0,25 oluyor.

### 8.2 Mini'den çıkış (mini pencereye tek dokunuş → 0,70)

```
Dokunuş  → SystemUI WMShell input monitörü  MiuiFreeformModeController.handleTouchEvent  (kayıtta 3588 çağrı: tüm dokunuşlar buradan geçer)
└─ MiuiFreeformModeTouchState.singleTap(taskId)                    :78
   └─ MiuiFreeformModeMiniStateHandler.singleTap                   :17/:36/:75
      ├─ MiuiFreeformModeTaskRepository.onTaskModeChanged (1→0)
      │    └─ MiuiFreeformModeController.onTaskModeChanged (:27, :48) + startAutoOrderingAvoidMini
      ├─ setMiuiFreeformInfoChange(WCT, {windowState=0, freeFormScale=0.7})  → MiuiFreeFormManagerService (mMiuiFreeFromWindowMode = 0)
      └─ MiuiFreeformModeAnimation.applyMiniFreeformTapAnimation (anim tipi 4, ~0,6 sn)  → kutu eski yerine döner (347,154,1201,1520)
```

### 8.3 Ölçülen deney: dışarıdan geri açma (KANIT)

20:44:31'de `adb shell input -d 0 tap 1024 398` (mini Chrome'un ortası) tek başına yetti: 20:44:32.4'te SF ölçeği 0,25 → 0,70, kutu mini'den önceki
ile birebir aynı. Yani `singleTap` yolu gerçek parmakla enjekte edilmiş dokunuşu ayırt etmiyor. **Geri alma için karmaşık bir merdivene gerek yok:
mini'nin SF kutusunun ortasına tek dokunuş.** (Doğrulanmadı: sanal ekranda — Workspace, display 42 — aynı monitör var mı; 27 Ekim kaydında mini orada da
oluşmuştu, dolayısıyla büyük olasılıkla var. Test: Workspace açıkken mini'yi oluştur, `input -d <vd> tap <merkez>`.)

### 8.4 Önleme

- SystemUI dex'inde (63 MB, 3 dex) "Home'da mini yap"ı kapatan **ayar anahtarı bulunmadı** (`freeform_*` anahtarları yalnız boyut/animasyon/ipucu).
  `settings` içinde `miui_freeform_enable=0`, `freeform_window_service=0`, `enable_freeform_support=1` var; hiçbiri toHome davranışına bağlı görünmüyor
  (denenmedi, kanıt yok). Log'da `miui_dkt_mode` (masaüstü modu) okunuyor ve bulunamıyor; masaüstü modunda `DESKTOP_HIDE_FREEFORM` yolu var — olası
  ama bütün arayüzü değiştirir, öneri DEĞİL.
- `miuifreeform` Shell komutları: `exitFreeformTask <taskId>`, `setFreeformLogState`, `setFolmeLogLevel`. Mini'yi önleyen komut yok.
- Geri açmak için shell komutu YOK (`miuifreeform` yalnız `exitFreeformTask` — freeform'dan ÇIKARIR, mini'den açmaz). "adb wm" benzeri temiz yol adayı:
  `framework.jar` içinde `WindowContainerTransaction.Change.setMiuiFreeformInfoChange(miui.app.MiuiFreeFormManager$MiuiFreeFormInfoChange)` var; SystemUI
  mini'ye girerken/çıkarken tam bunu uyguluyor (`{windowState=0, freeFormScale=0.25|0.7}`). Daemon zaten WCT uyguluyor (`set_task_windowing`), yani
  aynı değişikliği shell uid'iyle göndermek mümkün olabilir. DENENMEDİ: alan/kurucu imzası ve system_server'ın shell'den kabul edip etmediği,
  SystemUI'nin kendi görev kaydının (`MiuiFreeformModeTaskRepository`) buna uyup uymadığı bilinmiyor. Servis tarafında `restoreMiniToFreeformMode`
  (`MiuiFreeFormManagerService`) var ama dışarı açık bir giriş noktası bulunmadı.
- Sonuç: Home jestinin mini yapmasını **engelleyemiyoruz** (HyperOS davranışı). Çözüm = **hızlı algıla + tek dokunuşla geri aç**.

## 9. Güncellenmiş plan (§5.3'ün yerine geçer)

| # | iş | not |
|---|---|---|
| P1 | `is_mini` (SF ölçeği < 0,5 × cihaz ölçeği) + mini okumasını deftere/cihaz profiline YAZMA (§5.4) | küçük, testli, zararı keser |
| P2 | `restore_from_mini(task)`: SF kutusunun merkezine tek dokunuş (scrcpy kontrol kanalı ya da `input -d <vd> tap`), 0,7 sn sonra SF ile doğrula, olmazsa bir kez daha | yeni, ~40 satır |
| P3 | Tetikler: `resize_task` başı, `verify_member`, daemon odak olayı (Home/launcher öne gelince, Workspace açıksa 1 SF kontrolü) | Home jesti ≈ launcher odağa gelir (20:40:51.578 `moveTaskToFront(Launcher)`) |
| P4 | React: mini algılanınca çerçeveyi son sağlıklı kutuda tut, üstüne "Küçültüldü — dokun/otomatik açılıyor" rozeti; kullanıcı rozete basarsa P2 çağrılır | `workspace_task_mini` olayı |
| P5 | (opsiyonel) otomatik: mini algılanır algılanmaz sessizce geri aç | HyperOS'un mini animasyonu (~0,7 sn) bitince, yoksa animasyonu bölmemek için |

Öneri: P2'yi otomatik değil **"mini oldu → rozet + otomatik geri aç, 0,8 sn gecikmeyle"** yap; kullanıcı gerçekten küçültmek isteyebilir (bayrak: ayar).

## 9b. Sanal ekran denemesi (2026-10-28 20:52–21:10, KANIT) — mini oluşmadı

Backend çalıştırıldı, Workspace'e (VD 85–88) Play Store açıldı (Chrome Uygulama Kilidi'nin arkasında kalıyor, ölçüm bozuyordu). Telefonda Home jesti 3 kez
yapıldı (biri sanal ekranı `mTopFocusedDisplayId` yaptıktan sonra). Sonuç: `toHome` yayını gelip `allFreeformFromFreeformToMini` çalıştı ama **Workspace
görevi küçülmedi** (WM aynı, SF değişmedi, `applyFreeformToMiniAnimation` yok). Neden: SystemUI'nin freeform listesi (`MiuiFreeformModeTaskRepository.
mFreeformTaskIdsInZOrder`) hep boştu; mini yapan fonksiyon yalnız bu listeyi dolaşıyor. Sistem servisi (`MiuiFreeFormManagerService`) VD görevini freeform
yığını olarak tanıyor (`windowState=0 freeFormScale=0.7`) ama SystemUI listesine girmiyor. Telefondan alma (adopt) yolunda da liste boş kaldı.
Telefonda (display 0) `am start --windowingMode 5` ile açılan görev ise listeye giriyor (`[2041]`) ve Home ile mini oluyor.

Yeniden üretilemeyen: 27 Ekim 23:44'teki Chrome (başka VD'den **dock** ile gelmişti, "SF render_bounds bulunamadı" satırları var). Açık hipotez: o yolda görev
SystemUI listesine girmişti. Test edilmedi (dock yolu: bağımsız pencere → `/windows/dock`). Sonuç: mini yalnız belirli giriş yollarında oluşuyor olabilir; P1/P2
yine de güvenlik ağı olarak gerekli, ama aciliyeti düşük.

Yan bulgu (düzeltildi): VD'de `am start --windowingMode 5` görevi FULLSCREEN başlatıyordu; `open_in_workspace` yalnız taşınan görevleri freeform'a çeviriyordu,
varış koruması ~2 sn sonra yanlış kutuyla düzeltiyordu. Artık açılışta tek işlemde freeform + kutu (testli).

## 10. Yapılmadı / sınırlar

Kod değişmedi, test çalıştırılmadı. Sanal ekran (display 42) üzerinde deneme yapılmadı (OpenDeX arka ucu kapalıydı). Telefonda geçici olarak açılan loglar kapatıldı,
cihazdaki 268 MB perfetto izi silindi (PC'de kopyası var). Çökme: izleme sırasında argümansız `WMShell protolog` dökümü SystemUI'yi çökertti (20:37:45,
kayıtla doğrulandı; o ana kadar SystemUI bu telefonda zaten ayda birkaç kez çöküyor) — çökmeden sonra Chrome freeform'dan fullscreen'e düştü.
