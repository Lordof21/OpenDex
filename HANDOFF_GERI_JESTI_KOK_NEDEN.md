# Telefona aktarımdan sonra kenar "geri" hareketinin çalışmaması — kök neden raporu

Tarih: 2026-10-11 · Cihaz: POCO 2412DPC0AG, HyperOS 3 / Android 16 · **Kod değiştirilmedi** (yalnızca okuma + cihaz kaydı).
Kanıt: tekrar üretilen aktarım 19:55:39 (kullanıcı 15 kenar denemesi yaptı), `logcat` (main+system+events) ve 0,5 sn'lik odak
kaydı. Ham dosyalar: oturumun scratchpad klasörü (`logcat_full.txt`, `focus_poll2.txt`).

---

## 1. Özet

Sorun **odak ya da klavye değil**. Telefonun kenar geri hareketini HyperOS Home'un (`com.miui.home` / `com.mi.android.globallauncher`)
**GestureStubLeft/GestureStubRight** pencereleri işliyor. Aktarımdan sonra bu pencereler *"Launcher önde"* durumunda **dokunuşa
kapalı** kalıyor: Home, Chrome'un artık telefonda öndeki uygulama olduğunu **hiç öğrenmiyor**. Her kenar dokunuşu
`redirectSource = view_touch_disabled` ile uygulamaya (Chrome'a) yönlendiriliyor — kullanıcının gördüğü "Chrome'un kendi kenar
geri özelliği" tam olarak bu. Ana ekrana gidip uygulamayı yeniden açmak Home'a gerçek bir "ön plan değişti" olayı verdiği için
düzeltiyor.

Kök neden, uygulamanın sanal ekranda zaten **RESUMED** olduğu bir görevi WCT ile telefona taşımamızdır: Android tarafında
"ön plana yeni geçiş" olmadığı için Home'un ön-plan dinleyicisi tetiklenmiyor (çıkarım — aşağıda neyin kanıtlı, neyin çıkarım
olduğu ayrıldı).

---

## 2. Kanıt zinciri (19:55 tekrarı, saatler cihaz saatidir)

| Saat | Olay | Kaynak |
|---|---|---|
| 19:55:33.697 | Home: `onForegroundChanged → com.mi.android.globallauncher` | `RecentsImpl` |
| 19:55:33.750 | `GestureStubView_Left/Right: setBackTouchable changed: true->false` + `hideGestureStub` (Home önde: kenar jesti kapalı — **doğru**) | Home |
| 19:55:39.074–.186 | Chrome, sanal ekranda (48) ön-iniş yeniden boyutlandırması yüzünden yeniden kuruldu; `wm_on_top_resumed_gained_called` | Chrome |
| 19:55:39.188–.189 | Home: `isAnotherDisplay, appDisplayId=48, homeDisplayId=0 → activityResumed, another display, return` — **Home bu olayı bilerek yok sayıyor** | `RecentsImpl` |
| 19:55:40.072 | `wm_task_moved [491,491,0,…]` — görev Display 0'a taşındı (WCT) | system_server |
| 19:55:40.096 | `Launcher wm_on_top_resumed_lost_called` (Home artık üstte değil) | Home |
| 19:55:40.12 | InputDispatcher: `At display 0, focus update to Chrome`; WMS `mTopFocusedDisplayId=0`; IME hedefi display 0 — **odak doğru** | system_server + kayıt |
| 19:55:40.2–.4 | bizim `sync_display0_focus`: `input -d 0 motionevent DOWN 610 1356` + `CANCEL`, `CLOSE_SYSTEM_DIALOGS`, ek `am start` (Chrome 3 kez pause/resume oldu) | log |
| 19:55:41.743 → 19:56:37 | 15 kenar denemesi: her biri `GestureStubView_*: redirectEvent: redirectSource = view_touch_disabled` + `RedirectionHelper: requestRedirect … successful` + stub'a `ACTION_CANCEL` | Home |
| 19:55:40 → 19:56:44 | Home'da **hiç** `onForegroundChanged → com.android.chrome` ve **hiç** `setBackTouchable false->true` yok | `RecentsImpl`, `GestureStubView` |
| 19:56:55.189 | (kullanıcı Home'a gidip Chrome'u yeniden açınca) `onForegroundChanged → com.android.chrome` → `setBackTouchable changed: false->true` + `showGestureStub` — **jest geri geldi** | Home |

Aynı cihazın ilk kaydında (19:46) normal bir uygulama açılışı da aynı çifti üretiyor (`onForegroundChanged` → `showGestureStub`);
yani bu, Home'un jesti açan **tek** mekanizması.

---

## 3. Elenen hipotezler (kanıtla)

| Hipotez | Sonuç | Kanıt |
|---|---|---|
| InputDispatcher / odaklı ekran sanal ekranda takılı kalıyor (`memory.md` §6) | ❌ **Çürüdü** | `FocusedDisplayId=0` ve `mTopFocusedDisplayId=0` 19:55:40.1'den itibaren; odaklı pencere Chrome; IME hedefi display 0 |
| Klavye / IME katmanı | ❌ | `imeInputTarget in display# 0` aktarımla birlikte geçti |
| Kenar jest pencereleri yok / yanlış yerde | ❌ | `GestureStubLeft [0,260][62,2636]`, `Right [1158…]` Chrome'un **üstünde** (z-sırası 6–7 < 14) |
| Chrome geri geri-çağrımı (`OnBackInvokedCallback`) kayıtsız | ❌ | `CoreBackPreview: Setting back callback …` kayıtları var; zaten jest Chrome'a hiç ulaşmadan stub'ta kesiliyor |

---

## 4. Neyin kanıtlı, neyin çıkarım olduğu

**Kanıtlı (günlükte görüldü):** stub'lar dokunuşa kapalı (`view_touch_disabled`); Home bu süre boyunca Chrome için ön-plan olayı
almadı; ilk olay sanal ekran için gelip "another display" diye yok sayıldı; ön plan olayı gelince jest açıldı; odak doğruydu.

**Çıkarım (doğrulanmadı):** *neden* ön-plan olayı üretilmiyor. En olası açıklama: MIUI'nin ön-plan bildirimi görevin
**RESUMED durumuna geçişinden** türüyor; Chrome görevi sanal ekranda zaten RESUMED idi, taşıma `RESUMED → RESUMED` bir
yeniden-parentleme olduğu için yeni geçiş yok (Chrome'un uygulama-tarafı pause/resume çifti — `wm_on_top_resumed_*` — sistem
tarafı durumu değiştirmiyor). Home'un kapalı kaynak kodunu okuyamadığım için bunu doğrudan kanıtlayamam.

**Açıklanamayan:** ilk tekrarda "Chrome'un kenar kaydırmasından sonra sistem geri çalıştı", son tekrarda çalışmadı. 19:53'teki
kayıtta aktarımın sonunda display 0'da kısa süre `com.android.keychain/.KeyChainActivity` odaklı uygulama oldu (0,5 sn) — gerçek
bir uygulama başlatması Home'a ön-plan olayı vermiş olabilir; bu aralıklılığı açıklayabilir ama o oturumun günlüğü yakalanmadı.

---

## 5. Kodda bulduklarım (`android_shell.sync_display0_focus`, `handoff_manager`)

* `sync_display0_focus` yanlış teoriye (odak eski ekranda kalıyor) göre yazılmış ve **bu hatayı çözmüyor**; üstelik yan etkisi var:
  * `input -d 0 motionevent DOWN/CANCEL` (ekran ortası) **gerçek bir dokunuş**: Chrome'a DOWN+CANCEL gidiyor, `[Gesture Monitor]
    WMShell` ve `miui-gesture` tetikleniyor, `MiuiMultiFingerGestureManager: Receive a cancel event, all gesture will fail`,
    MIUI Kenar Çubuğu (`SidebarTouchListener`) tepki veriyor. Handoff başına **iki kez** (CDP öncesi/sonrası).
  * `am broadcast CLOSE_SYSTEM_DIALOGS` açık sistem iletişim kutularını/gölgeyi kapatır.
  * Fazladan `am start … LAUNCHER` her seferinde Chrome'a ek pause/resume (`wm_on_top_resumed_lost/gained`) yaptırıyor.
* Bunların hiçbiri Home'un jest durumunu etkilemedi (aynı saniyelerde stub'lar kapalı kaldı). `memory.md`'deki "Display 0 Gesture
  Navigation & Touch Focus Synchronization" maddesi bu bulguyla çelişiyor ve güncellenmeli.
* Bağımsız gözlem: aktarım süresi 6–11 sn (`FE:handoff to_phone_done ms=10870` / ~6,5 sn); büyük kısmı odak senkronu + CDP
  dürtmesi (4–5 sn).

---

## 6. Çözüm seçenekleri (uygulanmadı; etki ve risk sırasıyla)

1. **Home'a gerçek bir ön-plan geçişi verin (kök nedenle uyumlu).** Görev taşınmadan önce sanal ekranda **RESUMED durumundan
   çıkarılıp** (ör. görünürlüğü düşürülüp/duraklatılıp), taşıma sonrası Display 0'da PAUSED/STOPPED → RESUMED geçişi
   yaşatılmalı; böylece ATMS gerçekten "bu uygulama ön plana geldi" olayını üretir ve Home `setBackTouchable(true)` yapar.
   Seçenekler: görevi VD'de arkaya almak + taşıma sonrası öne almak (iki WCT adımı). Risk: kısa görsel kare ve uygulamada
   bir pause/stop; **cihazda denenmeli** (varsayım: RESUMED→RESUMED olayı üretmiyor).
2. **Zararlı çözümleri kaldırın:** dokunuş enjeksiyonu, `CLOSE_SYSTEM_DIALOGS`, yinelenen `am start` — hata düzeltmiyorlar, yan
   etki üretiyorlar ve ~1–2 sn ekliyorlar (`memory.md` "kod bandajlama yasak" ilkesiyle de uyumlu).
3. **Doğrulama kapısı (iyileştirme değil, güvenlik):** aktarım sonunda Home'un durumunu *gözlemleyin* — günlükte
   (`onForegroundChanged → <paket>`) ya da daemon'un olay günlüğü okuyucusu üzerinden — ve gelmediyse (1)'deki geçişi tek
   sefer uygulayın. Böylece düzeltme yalnızca gerektiğinde çalışır.
4. **Reddedilen fikirler:** Home'un ayar anahtarlarını (`force_fsg_nav_bar` vb.) değiştirip stub'ları yeniden kurdurmak — OEM'e
   özgü, kalıcı ayarı kirletir, bandaj niteliğinde.

Genellik notu: bu bulgu **HyperOS Home** için kanıtlı. Pixel/Samsung gibi cihazlarda kenar geri hareketi SystemUI'nin
`EdgeBackGestureHandler`'ında; orada aynı sorunun görünüp görünmeyeceği ölçülmedi.

---

## 7. Doğrulama planı (düzeltme uygulanırsa)
1. Aynı kaydı yeniden alın (`logcat` + odak kaydı) ve aktarımdan sonra **`onForegroundChanged → com.android.chrome`** ile
   **`setBackTouchable changed: false->true`** satırlarını arayın — yoksa düzeltme işe yaramamıştır.
2. 10 art arda aktarım: her birinde ilk kenar denemesi çalışmalı (`view_touch_disabled` satırı **olmamalı**).
3. Başka uygulamalar (Galeri, WhatsApp, YouTube) ve ters yön (reclaim) ile tekrar — sorun yalnızca Chrome'a özgü değil.
4. Aktarım süresini yeniden ölçün (hedef: dokunuş enjeksiyonu + yinelenen `am start` kalkınca ≥1 sn kazanç).
