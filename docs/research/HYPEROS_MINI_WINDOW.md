> **Language note:** Turkish (translation on [roadmap](../ROADMAP.md)). HyperOS "mini floating window" (Home gesture shrinks a freeform window to 0.25×): cause, measured function tree, and the fix that ships.

# HyperOS mini yüzen pencere — Workspace penceresi 0,25'e düşüyor

**Tarih:** 2026-10-28 (cihaz ölçümleri) · **Cihaz:** POCO 2412DPC0AG, HyperOS 3 / Android 16 · **Durum:** çözüldü (algıla + tek dokunuşla geri aç), önleme yolu yok.

## 1. Ne oluyor

Telefonda orta tuş / yukarı jest (Home) yapılınca freeform pencere **mini yüzen pencereye** düşer. Workspace'te kullanıcı bunu "pencere 0,22'ye küçüldü" diye görür.

Ölçülen belirti (günlük 2026-10-27 23:44): WindowManager'da görev `mode=freeform visible=true`, bounds **değişmez**; yalnız SurfaceFlinger'daki pencere katmanının `toDisplayTransform` ölçeği 0,70 → 0,2269 (sonraki kayıtta 0,25) olur. Mini durumu **WindowManager'da görünmez**; HyperOS'un kendi kaydındadır (`MiuiFreeFormActivityStack.mMiuiFreeFromWindowMode = 1`).

Eski kodun yanlışları (bu yüzden zarar veriyordu):

- SF ölçeği cihazınkinden farklı çıkınca "pencere gerçekten öyle çiziliyor" deyip mini ölçeği deftere yazıyordu → çerçeve arayüzde 305×225'e iniyordu.
- Her `resize_task` görünür→Android dönüşümünü mini ölçeğiyle yapıyordu → kutu ~3× büyüyor, dört turda 106450×76112 px'e çıktı.
- Mini okuması iki kez üst üste gelirse cihaz ölçeği kalıcı olarak 0,2269 yazılabilirdi (gözlenmedi, kod okuması).

## 2. Mini'ye giriş ve çıkış — cihazda ölçülen işlev ağacı

Kayıt: `logcat -b all` + perfetto + 0,8 sn'de bir SF/WM yoklayıcı.

**Giriş (Home jesti → 0,25):**

```
com.miui.home  NavStubView.onTouchEvent → canTaskEnterSmallWindow → ActivityTaskManager.moveTaskToFront(Launcher)
  yayın com.miui.fullscreen_state_change { taskSnapshot → crossSafeArea → startControlAppWindow → toHome }
com.android.systemui  MiuiFreeformModeSettingsObserver.handleFreeFormReceiver
  └─ MiuiFreeformModeController.allFreeformFromFreeformToMini()          ← KÖK: TÜM freeform görevleri
       ├─ "small freeform {width:305 scale:0.25}"                        (mini ölçeği buradan)
       ├─ setMiuiFreeformInfoChange(WCT, {windowState=0, freeFormScale=0.25})
       ├─ MiuiFreeFormManagerService … mMiuiFreeFromWindowMode = 1
       └─ MiuiFreeformModeAnimation.applyFreeformToMiniAnimation (~0,7 sn)
```

**Çıkış (mini pencereye tek dokunuş → 0,70):**

```
SystemUI WMShell input monitörü  MiuiFreeformModeController.handleTouchEvent
  └─ MiuiFreeformModeTouchState.singleTap → MiuiFreeformModeMiniStateHandler.singleTap
       ├─ onTaskModeChanged (1→0)
       ├─ setMiuiFreeformInfoChange(WCT, {windowState=0, freeFormScale=0.7})
       └─ applyMiniFreeformTapAnimation (~0,6 sn) → kutu eski yerine döner
```

**Dışarıdan geri açma (KANIT):** `adb shell input -d 0 tap <mini kutunun ortası>` tek başına yetti — SF ölçeği ~1 sn içinde 0,25 → 0,70, kutu mini'den öncekiyle birebir aynı. `singleTap` yolu enjekte edilmiş dokunuşu gerçek parmaktan ayırmıyor. Karmaşık bir kip/WCT merdivenine gerek yok.

**Yalnız display 0'da çalışır:** SystemUI'nin dokunuş monitörü yalnız fiziksel ekranı dinler; sanal ekrana enjekte edilen dokunuş düşer.

## 3. Önleme yok

- SystemUI dex'inde "Home'da mini yap"ı kapatan ayar anahtarı **bulunamadı** (`freeform_*` anahtarları yalnız boyut/animasyon/ipucu). `miui_freeform_enable`, `freeform_window_service`, `enable_freeform_support` toHome davranışına bağlı görünmüyor (denenmedi).
- `miuifreeform` shell komutları: `exitFreeformTask`, `setFreeformLogState`, `setFolmeLogLevel` — ne önler ne mini'den açar (`exitFreeformTask` freeform'dan ÇIKARIR).
- Jesti engellemek mümkün değil (sistem jesti).
- Aday ama denenmedi: `WindowContainerTransaction.Change.setMiuiFreeformInfoChange(...)` ile `{windowState=0, freeFormScale=0.7}` göndermek. SystemUI'nin kendi görev kaydı buna uyar mı bilinmiyor; dokunuş yolu zaten çalıştığı için gerekmedi.

Sonuç: **hızlı algıla + tek dokunuşla geri aç.**

## 4. Sanal ekranda mini oluşmuyor (9b denemesi)

Workspace'e (sanal ekran) Play Store açıldı, telefonda Home jesti 3 kez yapıldı (biri sanal ekranı `mTopFocusedDisplayId` yaptıktan sonra). `toHome` yayını geldi ve `allFreeformFromFreeformToMini` çalıştı, ama Workspace görevi **küçülmedi**: SystemUI'nin freeform listesi (`MiuiFreeformModeTaskRepository.mFreeformTaskIdsInZOrder`) hep boştu ve mini yapan fonksiyon yalnız bu listeyi dolaşır. Sistem servisi VD görevini freeform yığını olarak tanıyor ama SystemUI listesine girmiyor. Telefonda (display 0) `am start --windowingMode 5` ile açılan görev ise listeye giriyor ve Home ile mini oluyor.

Yeniden üretilemeyen: 27 Ekim 23:44'teki Chrome (başka sanal ekrandan **dock** ile gelmişti). Açık hipotez: o yolda görev SystemUI listesine girmişti. Sonuç: mini yalnız belirli giriş yollarında (telefona alınmış / dock edilmiş görev) oluşuyor olabilir; geri açma güvenlik ağıdır, acil değil.

## 5. Ne yapıldı / ne yapılmadı

| | durum | nerede |
|---|---|---|
| Mini tanıma: SF ölçeği < 0,5 × cihaz ölçeği | **yapıldı** | `is_mini_scale` (`eco_workspace.py`) |
| Mini okuması deftere / cihaz ölçeğine yazılmıyor, çerçeve son sağlıklı kutuda | **yapıldı** | `_get_task_effective_bounds` mini dalı |
| Geri açma: WMShell dökümünden mini kutunun yeri → display 0'a tek dokunuş → SF ile doğrula; yer okunamazsa **tahmin edilen noktaya dokunulmaz** | **yapıldı** | `_restore_mini_task`, `parse_mini_task_info`; daemon RPC `restore_mini_task` ([DAEMON_PROTOCOL](../DAEMON_PROTOCOL.md)), adb yedeği |
| Tetikler: `resize_task` başı, `verify_member` (çerçeveye basınca) | **yapıldı** | `eco_workspace.py` |
| Tetik: telefonda launcher öne gelince (daemon odak olayı) tek SF kontrolü | yapılmadı | kullanıcı jesti yaptığı an pencere kendiliğinden dönerdi |
| Arayüzde "Küçültüldü — açılıyor" rozeti / `workspace_task_mini` olayı | yapılmadı | |
| Sanal ekranda mini'yi geri açma (display ≠ 0) | yapılmadı | mini orada oluşmadığı için gerek görülmedi |
| Mini'yi önleyen ayar | **bulunamadı** | §3 |
