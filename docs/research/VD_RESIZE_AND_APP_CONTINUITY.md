> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). Research on the phone-screen flash during VD resize and on app continuity (Samsung DeX comparison).

> Durum: §8 (geçiş animasyonu kapısı, `transition_gate.py`) ve §9 (`PlaybackContinuity`) uygulandı. Özet: [HANDOFF.md](../design/HANDOFF.md).

# VD yeniden boyutlandırmada telefon ekranına "pıt pıt" kare + Samsung DeX / App Continuity — araştırma

Tarih: 2026-10-15 · Yazan: Claude (kod + log + cihaz + dış kaynak taraması) · **Kod değişikliği yapılmadı**; yalnızca bulgu ve öneri.
Cihaz (salt okunur bakıldı): POCO 2412DPC0AG · HyperOS 3.0 (OS3.0.301.0) · Android 16 (SDK 36) · animasyon ölçekleri 1,0 · panel o an uykuda (`Dozing`).

Kullanıcı sorusu üç parçalı: (A) Yapıştırılan "scrcpy resize → telefon ekranına anlık kare" analizi doğru mu, **bizim sistem** bunu yapıyor mu?
(B) Gerçek neden nedir, nasıl ayırt ederiz? (C) Samsung DeX / "App Continuity" YouTube'u nasıl sorunsuz taşıyor, biz neyi benimseyebiliriz?

---

## 0. Kısa cevap

| Soru | Cevap | Güven |
|---|---|---|
| Yapıştırılan metin güvenilir mi? | **Kısmen.** Mekanizma 1 (VD silinince içerik) gerçek ama **resize'a uygulanmaz**. Mekanizma 2 (resize sırasında VD'nin `STATE_OFF` olup görevi Display 0'a düşürmesi) scrcpy v4.1 kaynağında **yok**. Mekanizma 3 (WM Shell sızıntısı) için **kaynak bulunamadı**. Atıf verilen üç GitHub sorunu (#5534, #5651, #6784) **konuyla ilgisiz** (§2). | Yüksek (kaynak kodu + AOSP + issue sayfaları okundu) |
| Bizim sistem resize'da VD'yi silip kuruyor mu? | **Hayır.** Son iki günde 127 resize isteğinin **127'si yerinde** (`VirtualDisplay.resize`, medyan **142–145 ms**), VD yıkılmadı. Yıkıp-kurma (legacy) yolu 12 Ekim'de 11 kez çalışmıştı; transpoze-onay düzeltmesinden sonra **0**. | Yüksek (log) |
| Resize sırasında kodumuz Display 0'a dokunuyor mu? | **Hayır.** Resize sonrasında adb/WCT işlemi yok (log). Display 0'a **bilerek** gittiğimiz yerler: *Telefona aktar*, *geri al*, *taşıyıcı geçişi* (USB↔Wi‑Fi). | Yüksek |
| "Pıt pıt"ın gerçek nedeni? | **ÖLÇÜLDÜ (§8):** resize'da WM/Shell'in geçiş animasyonu, VD içeriğinin anlık görüntüsünü telefonun **Display 0**'ına sızdırıyor (sol üst, ~100 ms'de sönüyor). `transition_animation_scale=0` iken **0/8**, varsayılanda **5/8 ve 3/8**. Çözüm: yalnızca resize etrafında bu ayarı 0'a çek (`TransitionGate`). | **Yüksek** (cihazda tekrarlandı, kontrollü deney) |
| Telefon ekranını kapatmak çözer mi? | **Büyük olasılıkla evet** (panel kapalıysa görünür kare olamaz) ve **özelliği zaten yazmışız** (`screen_off_while_mirroring`, daemon `display_power`). Eksik: yalnızca ilk pencerede uygulanıyor. | Yüksek (kod) / Orta (etki) |
| Samsung "sorunsuz" taşımayı nasıl yapıyor? | Sihir yok: **(1) süreç ölmüyor, (2) config değişimi uygulamaya yerinde iletiliyor (`configChanges`), (3) uygulama bunu karşılayacak yazılmış.** Bu cihazdaki YouTube ve Chrome manifestlerinde **kanıtlandı** (§5.2). | Yüksek |
| Xiaomi/HyperOS ne yapıyor? | **Kamuya açık teknik kaynak bulunamadı.** Tahmin yürütmüyorum. | — |

---

## 1. Yöntem ve kaynak güvenilirliği

* Yerel: `backend/scrcpy/build/scrcpy` içindeki **gerçek scrcpy v4.1 kaynağı** (`NewDisplayCapture.java`, `SurfaceEncoder.java`), bizim 4 yama, `scrcpy_launcher.py`, `session_reconfigure.py`, `handoff_manager.py`, `OpenDexDaemon.java`.
* Log: `backend/logs/opendex-20261012…14.log` (resize yolu, display‑0 olayları, pid sürekliliği).
* Cihaz (salt okunur): `getprop`, `dumpsys power/display`, **YouTube ve Chrome APK manifestleri** (`aapt2 dump xmltree`; APK'lar yalnızca ayrıştırıldı, çalıştırılmadı).
* Dış: scrcpy GitHub sorunları (sayfalar tek tek okundu), AOSP `VirtualDisplayAdapter.java` (aosp‑mirror), Samsung Developers, developer.android.com, Samsung destek, ek aramalar.
* **Yapıştırılan metin** başka bir yapay zekâ modelinin çıktısı; birincil kaynak değil. Aşağıda iddia iddia denetlendi. Arama sonucu çıkmayan şeyleri "doğrulanamadı" diye işaretledim.

---

## 2. Yapıştırılan analizin denetimi

### 2.1 Atıflar

| Atıf | Gerçekte ne | İddiayı destekliyor mu? |
|---|---|---|
| scrcpy #5534 | "Virtual display keeps increasing" — display id'lerinin artması. Maintainer: kapatınca VD yok edilir (`DESTROY_CONTENT_ON_REMOVAL` + `release()`). | **Yalnızca** "kapatınca içerik yok olur" kısmını. Resize/kare sızıntısı yok. |
| scrcpy #5651 | "Dynamic resolution scaling of virtual displays" — maintainer: `VirtualDisplay.resize()` var, yeniden kurmak gerekmez; SDL resize olaylarına **200–500 ms debounce** ekle. | **Hayır** (ters yönde: yerinde resize öneriyor). |
| scrcpy #6784 | "Dynamic DPI Scaling for Flex Display" — resize'da `wm density` yavaş; DPI'ı resize mesajına koyma isteği; maintainer reddetti. | **Hayır.** (Bizim yama 0002 tam bunu yapıyor.) |

Üç numaranın üçü de "ana ekrana kare düşmesi"ni anlatmıyor. Metindeki kaynak görünümü **doğrulanmış dayanak değil**.

### 2.2 Mekanizma 1 — "VD silinip yeniden açılıyor + `--no-vd-destroy-content`"

* Doğru olan: scrcpy VD'yi `VIRTUAL_DISPLAY_FLAG_DESTROY_CONTENT_ON_REMOVAL` ile açar (`NewDisplayCapture.startNew`); `--no-vd-destroy-content` v3.1'de eklendi (changelog #5615) ve kapanışta uygulamaların **ana ekrana taşınmasını** sağlar (Liliputing v3.1 özeti + #5534).
* **Resize'a uygulanmaz:** `--flex-display` (v4.0) ile `triggerResize()` doğrudan `virtualDisplay.resize(w, h, dpi)` çağırır (kodda okundu); VD yıkılmaz.
* Bizde: `scrcpy_launcher.py` `flex_display=true` verir; `vd_destroy_content` **varsayılan (true)** kalır, yani bir VD kapanırsa görevler **yok edilir, Display 0'a taşınmaz** (`unfreeze` docstring'i bunu açıkça yazıyor). Yıkıp‑kurma yalnızca **legacy yol**: sürümlü log:

| Gün | resize isteği | yerinde (FLEX_OK) | FLEX_FAIL | ACK_IGNORED | freeze |
|---|---|---|---|---|---|
| 12 Eki | 57 | 46 | **11** | 8 | 17 |
| 13 Eki | 33 | 33 | 0 | 0 | 0 |
| 14 Eki | 94 | 94 | 0 | 0 | 2 (taşıyıcı geçişi) |

12 Ekim'deki 11 hata, [TRANSITION_FRAME_GATE.md](TRANSITION_FRAME_GATE.md) raporunun §7.5'inde teşhis edilen **transpoze onay** hatasıydı (dikey kilitli uygulama → sunucu 800×1100 bildirir, beklenen 1100×800); `session_reconfigure.py:511` civarında düzeltildi, sonra **0**.
**Sonuç:** Mekanizma 1 bugünkü resize yolumuz için geçerli değil. 12 Ekim'de geçerliydi (legacy), ama orada da görev Display 0'a **taşınmıyor, yok ediliyor** ve yeni VD'de `START_APP` ile yeniden başlatılıyor.

### 2.3 Mekanizma 2 — "SurfaceEncoder sıfırlanırken yüzey kopar → `STATE_OFF` → görev Display 0'a düşer"

Kaynak kodundan (v4.1, olduğu gibi):

1. Encoder döngüsü (`SurfaceEncoder.streamCapture`) her reset'te **sırayla**: `encode()` biter → `capture.stop()` → `mediaCodec.stop()/reset()` → `surface.release()` (eski) → döngü başı: `capture.prepare()` → `configure()` → `createInputSurface()` → `capture.start(surface)` → `virtualDisplay.setSurface(yeni)`. Yani **eski yüzey serbest bırakılıp yenisi bağlanana kadar** kısa bir aralık gerçek (metnin "5–15 ms boşluk" betimlemesi mantıklı).
2. **Ama** `virtualDisplay.setSurface(null)` scrcpy sunucusunda **hiç çağrılmıyor** (`grep setSurface server/src` → tek satır: `NewDisplayCapture.java:280`, `setSurface(surface)` yeni yüzeyle).
3. AOSP `VirtualDisplayAdapter.VirtualDisplayDevice.getDisplayDeviceInfoLocked`: **`mSurface == null` ise `STATE_OFF`**, değilse `mDisplayState` (varsayılan `STATE_ON`). Bizde `mSurface` hiç null olmuyor (eski nesne yeni nesneyle değişiyor) → **`STATE_OFF` oluşmaz.** `resizeLocked` yüzeye dokunmaz; boyut `performTraversalLocked` içinde `t.setDisplaySize` ile uygulanır.
4. "Görevin odağını/leash'ini 1 VSYNC Display 0'a düşürür" iddiasına dair **hiçbir kaynak bulunamadı** (arama + AOSP dosyası). WM, görevleri bir ekrana (DisplayContent) bağlar; VD'nin yüzeyi değişince görev başka DisplayContent'e **taşınmaz**.

Değerlendirme: encoder‑reset zamanlaması **gerçek ve PC tarafında çöp kare üretiyor** (bkz. [TRANSITION_FRAME_GATE.md](TRANSITION_FRAME_GATE.md) §7: Ayarlar'da 390–480 ms siyah/yarım kare). Ama bu **PC'ye giden akıştaki** karelerdir; telefonun fiziksel ekranında görünür bir olay üretmesi için kanıt yok.

### 2.4 Mekanizma 3 — "WM Shell geçiş anlık görüntüsü Display 0'a bağlanır"

Doğrudan kaynak **yok**. Android 12+'ta geçiş animasyonlarını Shell'in çizdiği doğru (genel mimari bilgisi), ama "VD'de `OWN_CONTENT_ONLY` eksikse / `vd_system_decorations=false` ise ekran görüntüsü katmanı Display 0 köküne bağlanır" **spekülasyon**. Not: bizde `OWN_CONTENT_ONLY` upstream bayraklarında **var** (`startNew`), `vd_system_decorations=false` **veriyoruz**. Test edilebilir (§4, H3).

### 2.5 Önerilen çözüm adımları

| Adım | Değerlendirme |
|---|---|
| **1. Animasyon ölçeklerini 0 yap** | Deney olarak geçerli (ucuz, geri alınır). Ama **küresel** yan etkisi büyük (telefonun tüm animasyonları gider); varsayılan çözüm olamaz. Şu an zaten 1,0. Yalnızca **tanı** için §4'te. |
| **2. Eski yüzeyi yeni hazır olana kadar koparma ("atomik") ** | **Bedeli düşünülmemiş:** scrcpy tek `MediaCodec`'i `reset()` ile yeniden kullanır. Yenisi hazır olana kadar eskisini tutmak için **ikinci bir donanım encoder oturumu** gerekir (cihazda eşzamanlı encoder sınırı var — bkz. Encoder kapasite testi, bütçe ayırıcı). Ayrıca VD zaten null olmadığı için hedeflenen sorun (STATE_OFF) **yok**. Değer/risk oranı zayıf; kanıtlı bir yarar çıkarsa 0005 yaması olarak düşünülür. |
| **3. Fiziksel ekranı donanımsal kapat (`display_power`)** | **Zaten var**: `OpenDexDaemon.setDisplayPower` (3 kademeli: `requestDisplayPower` → SurfaceControl → keyevent) + "ekranı sonsuza kadar karanlık bırakma" fail‑safe işareti + `DisplayPowerController`; ayar: `screen_off_while_mirroring`. Eksik: yalnızca **ilk pencerede** uygulanıyor (`apply_screen_off_setting`), telefon sonradan uyanırsa (bildirim, kullanıcı) yeniden uygulanmıyor. En kesin çözüm bu; ama telefonu aynı anda kullanmak isteyen kullanıcı için seçenek olamaz. |

---

## 3. Bizim sistem şu an ne yapıyor? (kanıtlı)

* **Resize** (`session_reconfigure._flex_resize` → yama 0002 `OPENDEX_RESIZE`): boyut + DPI **tek** `VirtualDisplay.resize`; log: `[Resize:FLEX_OK] … (sıfır donma, oturum korundu)`; **medyan 142 ms, p90 170 ms, en çok 262 ms** (94 istek, 14 Ekim). Ardından encoder reset + anahtar kare isteği (yama 0004: encoder yeniden başlamadan I‑frame).
* Resize sonrası log satırları: yalnızca video pompası, keyframe, bütçe/FPS; **Display 0'a dokunan komut yok**.
* **Display 0'a bilerek gittiğimiz yerler** (log: `TASK MOVE:WCT … → display=0`; 13 Ekim: 5, 14 Ekim: 13 olay):
  1. *Telefona aktar* (handoff) ve *geri al* (reclaim),
  2. **Taşıyıcı geçişi** (USB↔Wi‑Fi): 14 Ekim 11:14:53 görevler Display 0'a alındı, `FREEZE reason=transport`, 11:14:58–59 `UNFREEZE` (~5 sn). Bu sırada telefon ekranında görev **görünür** — tasarım gereği.
* Sunucu seçenekleri: `flex_display=true`, `display_ime_policy=local`, `vd_system_decorations=false`; `vd_destroy_content` varsayılan.
* **Handoff'ta süreç sürekliliği** ([HANDOFF_SEAMLESS_TRANSITION.md](HANDOFF_SEAMLESS_TRANSITION.md)'deki P0 kısmen uygulanmış): `restart_task_activity` artık yalnızca `not prelanded or is_web_rendered_app` iken çalışıyor. Log: Chrome `pre_landing/reclaim → adapted … pid 12454 → 12454` (pid sabit). `open` sırasında Chrome'da `restarted | pid 30758 → 7121` hâlâ görülüyor (web‑render uygulamasına özel yol).

---

## 4. "Pıt pıt"ın gerçek nedeni — ayırt edici test (≈15 dk, kod yok)

Önce **neyi** gördüğünüzü ayıralım: (i) telefonun *fiziksel panelinde* bir an görünen kare mi, (ii) PC penceresindeki geçiş karesi mi ([TRANSITION_FRAME_GATE.md](TRANSITION_FRAME_GATE.md) raporundaki çöp kareler, 0,15–0,5 sn)? İkisi farklı sorun ve farklı çözümdür.

**Test 1 — gerçek kompozit kare mi, panel titremesi mi?** Telefon açık, bir pencereyi sürükleyerek birkaç kez büyüt/küçült; aynı anda kaydet:

```
adb shell screenrecord --time-limit 20 /sdcard/d0.mp4      # Display 0'ı kaydeder
adb pull /sdcard/d0.mp4
```
* Videoda **kare görünüyorsa** → Display 0'a gerçekten bir şey kompozit edilmiş (H2/H4) → Test 2.
* Videoda **görünmüyor** ama gözle görülüyorsa → kompozit kare değil; **panel/yenileme** (H1) → Test 3.

**Test 2 — Display 0'a ne düşüyor?** (resize anında)
```
adb logcat -c
adb logcat -b events -v threadtime | findstr /R "wm_task_moved wm_create_task wm_set_resumed_activity wm_focused_root_task wm_on_top_resumed"
adb shell dumpsys SurfaceFlinger --list                         # resize öncesi/sonrası katman farkı
```
`display 0` içeren satır çıkarsa kaynağı (hangi görev/paket) görürsünüz; çıkmazsa H2 elenir.

**Test 3 — yenileme hızı:** (AOSP anahtarları; HyperOS ayrıca kendi "yenileme hızı" arayüz ayarını da kullanabilir)
```
adb shell settings get system peak_refresh_rate ; adb shell settings get system min_refresh_rate
adb shell settings put system min_refresh_rate 60 ; adb shell settings put system peak_refresh_rate 60
```
Titreme kesilirse neden yenileme modu geçişi (VD/encoder yükü `DisplayModeDirector` oylarını değiştirir). Eski değere dönün.

**Test 4 — Shell/dekor:** `vd_system_decorations` (bugün `false`) ile `true` karşılaştırması (geçici yerel deneme); titreme azalırsa H3.

Hipotezler (olasılığa göre, **hepsi doğrulanmadı**):

| # | Hipotez | Neden akla yatkın | Elemek için |
|---|---|---|---|
| H1 | Panel/yenileme hızı titremesi (LTPO, düşük parlaklık) | VD/encoder yükü ekran modu oylarını değiştirir; Display 0 içeriği değişmediği hâlde "kare" gibi algılanır | Test 1 (videoda görünmez) + Test 3 |
| H2 | HyperOS'un config‑change sırasındaki davranışı (Uygulama Kilidi, kilit/uyandırma, görev yeniden değerlendirme) Display 0'a kısa süre dokunuyor | MIUI Uygulama Kilidi daha önce VD akışına girmişti ([TRANSITION_FRAME_GATE.md](TRANSITION_FRAME_GATE.md) §7); `display 0` işlemleri OEM'de sık | Test 2 |
| H3 | `vd_system_decorations=false` + Shell geçişi (yapıştırılan metnin Mekanizma 3'ü) | Kaynak yok; yalnızca test edilebilir | Test 4 |
| H4 | Çöp kare PC tarafında (encoder reset), "telefon" diye anlatılıyor | Ölçüldü: 130–480 ms | Kullanıcı netleştirmesi |
| H5 | Legacy yol / taşıyıcı geçişi (12 Ekim) | 13–14 Ekim'de 0; transport'ta bilerek | Log: `FLEX_FAIL`, `FREEZE` sayısı |

---

## 5. Samsung DeX / App Continuity: YouTube neden sorunsuz?

### 5.1 Kaynaklar ne diyor

* **Samsung — "Optimizing your app"** (okundu): mobil⇄DeX geçişi **çalışma zamanı konfigürasyon değişimi**dir (rotasyon gibi); *"uygulamanın yeniden başlatılmasına zorlanabilir."* Önerilen manifest: `orientation|screenSize|smallestScreenSize|density|screenLayout|uiMode|keyboard|keyboardHidden|navigation`. **Süreç ölmesin** diye meta‑data: `com.samsung.android.keepalive.density=true` (DeX 3.0 öncesi) / `com.samsung.android.multidisplay.keep_process_alive=true` (DeX ≥3.0, Dual Mode). Sayfa durum kaydetmeyi anlatmıyor; `onConfigurationChanged` içinde "mod geçiş mantığını kendiniz yazın" diyor.
* **Samsung blog (2017) — Lifecycle on switching:** bayrak yoksa uygulama geçişte **yok edilip yeniden kurulur**; bayrak + `configChanges` ile süreç öldürülmez, `onConfigurationChanged → onRestart → onStart → onResume` akışı çalışır. (Arama özeti; 2017 tarihli, güncel One UI'da değişmiş olabilir.)
* **Android — Support connected displays** (okundu): bir activity ikinci ekrana taşınınca *"context güncellemesi, pencere yeniden boyutlanması, yapılandırma ve kaynak değişimleri"* yaşar; **activity değişimi karşılıyorsa `onConfigurationChanged()`, değilse yeniden başlatılır.** Ekran kesilirse activity birincil ekrana taşınır ve yeniden oluşturulabilir. Uygulama UI durumunu kaydetmeli/geri yüklemeli.
* **Samsung Foldable — App continuity** (arama): "app continuity" = **uygulamanın config değişiminde kullanıcı durumunu koruması** (sekme, kaydırma, klavye, metin); ayrıca ayarlarda "Continue using app on cover screen" (katlayınca uygulamayı kapatma). Yani iki ayrı şey: *geliştirici sözleşmesi* + *kullanıcı ayarı*.
* **Samsung — One UI 8 "Send to other display"** (destek sayfası): menü var; **çalışan uygulamanın kayıpsız taşındığına dair doğrulayıcı kaynak bulunamadı**.
* **AOSP** (önceki rapor §2): "auto‑restart on display move" bayrağı — Google bile yalnız yoğunluğu önbelleğe alan uygulamalar için süreç yeniden başlatmayı seçiyor.
* **Xiaomi HyperOS/澎湃OS:** uygulama akışı/akıl yürütme için **kamuya açık teknik kaynak bulunamadı** (haber/inceleme düzeyi içerik; "妙享桌面" uzaktan görüntüleme gibi). Bu konuda bilgi uydurmuyorum.

### 5.2 Kanıt: bu cihazdaki gerçek manifestler (`aapt2 dump xmltree`)

| Uygulama | Activity | `configChanges` | Diğer |
|---|---|---|---|
| YouTube 21.41.525 | `…watchwhile.MainActivity` | **`0x1ff0`** = keyboard\|keyboardHidden\|navigation\|orientation\|screenLayout\|uiMode\|**screenSize\|smallestScreenSize\|density** | `launchMode=singleTop`, `resizeableActivity=true`, `supportsPictureInPicture=true` |
| Chrome 155.0.8059.39 | `ChromeTabbedActivity` | **`0x40005ffb`** = fontScale\|colorMode\|**density\|smallestScreenSize\|screenSize**\|uiMode\|screenLayout\|orientation\|navigation\|keyboardHidden\|keyboard\|touchscreen\|mnc\|mcc | `launchMode=singleInstancePerTask`, `resizeableActivity=true`, `supportsPictureInPicture=true` |

**Çıkarım:** YouTube, boyut/yoğunluk/ekran düzeni değişimini **activity'yi yeniden kurmadan** (`onConfigurationChanged`) karşılıyor; oynatıcı/medya oturumu aynı süreçte yerinde kalıyor. "Sorunsuz" görünmenin gerçek nedeni **uygulamanın kendi hazırlığı**; Samsung'un katkısı bunun üstüne **süreci ayakta tutan çerçeve desteği** (keepalive meta‑data'sını okuyan framework) ve uygulamaları bu sözleşmeye uyduran bir **uyumluluk programı**.
Aynı satırlar bizim loglarımızla uyumlu: Chrome'da config yerinde işleniyor ama **sayfa ölçeği ×1,2 takılı kalıyor** (önceki rapor §6.2) — `configChanges` "yerinde karşıla" der, "doğru karşıladı" demez.

### 5.3 Bizimle fark ve benimseyebileceklerimiz

| Samsung'un avantajı | Bizde eşdeğeri | Boşluk |
|---|---|---|
| Platform imzası: görevi ekranlar arası kendi framework API'siyle taşır, keepalive'ı framework okur | `WindowContainerTransaction` (shell kimliği) ile tek‑atomik reparent + windowingMode + bounds + density; **HyperOS keepalive meta‑data'sını okumaz** (belge yok) | Süreç ölümünü framework değil **biz** önlemeliyiz (zaten: pid sabit). |
| Geçişi **görünmez** yapar (mod geçişinde ekran siyahlanır) | **Ön‑iniş**: VD'yi telefon boyutu+DPI'ına PC perdesi arkasında tek `OPENDEX_RESIZE` ile çek, sonra taşı | Var ve loglarla doğrulanmış (pid değişmiyor). |
| Uyumluluk programı / önerilen manifest | Uygulamayı değiştiremeyiz | Davranış öğrenme: hangi paket relaunch oluyor → öğrenilen profil (önceki raporda önerildi). |
| `onSaveInstanceState` zinciri (uygulama işbirliği) | Süreç ölürse state yok | Medya için **MediaSession anlık görüntüsü + konum/oynat** (P4, uygulanmadı). |

**YouTube'a özel nokta:** `launchMode=singleTop`. Handoff'taki `am start --display 0 … -f 0x10020000 --activity-reorder-to-front` mevcut örneğe `onNewIntent` olarak LAUNCHER intent'i iletir; YouTube genelde yok sayar, ama başka `singleTop` uygulamalarda kök ekrana dönüş riski var (önceki rapor P2: görev zaten görünürse `am start` atlanmalı).

---

## 6. Öneriler (önem sırasıyla)

1. **Önce teşhis (kod yok):** §4 Test 1 → hangi dalda olduğumuzu söyler. Beklenen en olası sonuç H1 veya H2.
2. **Düşük riskli, hemen değer:** `screen_off_while_mirroring` yalnızca ilk pencerede değil, **ekran uyandıkça yeniden uygulansın** (fail‑safe + toggle'a saygı ile); arayüzde "Yansıtırken telefon ekranını kapat" kısayolu. (Panel kapalıyken sızıntı gözle görülmez.)
3. **Resize yolu zaten sağlıklı** (127/127 yerinde, ~142 ms): bu yola **dokunma**. Atomik yüzey yaması (0005) ancak Test 1 çöp karenin telefon değil PC tarafında olduğunu ve encoder penceresinden geldiğini gösterirse; o hâlde asıl çözüm PC tarafı **sunum kapısı** (TRANSITION_FRAME_GATE.md §3A).
4. **Animasyon ölçeği** yalnızca tanı: geçici sıfırla/geri al; kalıcı yapma.
5. **App continuity için:** (a) handoff'ta `am start` artık yedek olsun (P2); (b) web‑render uygulamalarındaki yeniden başlatma (Chrome `open`) görünür aralıkta değil ön‑inişte; (c) medya uygulamaları için MediaSession konum/oynat anlık görüntüsü (yalnızca süreç ölümü kaçınılmazsa).
6. **Doğrulanacaklar (açık):** Test 1–4 sonuçları; Xiaomi'nin kamuya açık "uygulama akışı" belgesi (bulunamadı); Samsung "Send to other display"ın süreci koruyup korumadığı (belge yok; kendi cihazınızla denenebilir).

---

## 7. Sınırlar (dürüstlük notu)

* Bu rapor sırasında telefonda **pencere açıp resize etmedim** (kullanıcının oturumunu bozmamak için); "pıt pıt" kendi gözümle yeniden üretilmedi. Neden hipotezleri **kanıtlanmamıştır**; §4 testleri bunun içindir.
* `STATE_OFF` kodu AOSP `main` aynasından okundu; HyperOS'un kendi değişiklikleri (kapalı kaynak) farklı olabilir.
* Samsung belgelerinin bir kısmı 2017–2021 tarihli; güncel One UI davranışı değişmiş olabilir.
* Web aramasının bazı sonuçları ince/ikincil kaynaklıydı (özellikle Xiaomi); bunlar için karar vermedim.

---

## Kaynaklar

* scrcpy #5534 — Virtual display keeps increasing: https://github.com/Genymobile/scrcpy/issues/5534
* scrcpy #5651 — Dynamic resolution scaling of virtual displays: https://github.com/Genymobile/scrcpy/issues/5651
* scrcpy #6784 — Dynamic DPI Scaling for Flex Display Mode: https://github.com/Genymobile/scrcpy/issues/6784
* scrcpy 4.0 flex display haberi: https://www.androidauthority.com/scrcpy-4-0-update-flex-display-3667375/ · https://ubuntuhandbook.org/index.php/2026/05/scrcpy-4-0-resizable-virtual-display/
* scrcpy v3.1 `--no-vd-destroy-content` (Liliputing özeti): https://liliputing.com/scrcpy-3-0-adds-a-virtual-android-display-to-your-windows-mac-or-linux-pc/
* AOSP `VirtualDisplayAdapter.java` (mirror): https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/services/core/java/com/android/server/display/VirtualDisplayAdapter.java
* Android `VirtualDisplay` (setSurface(null) = ekranı kapatmak): https://developer.android.com/reference/android/hardware/display/VirtualDisplay
* Samsung — Optimizing your app: https://developer.samsung.com/samsung-dex/modify-optimizing
* Samsung — Lifecycle on switching between Mobile and DeX: https://developer.samsung.com/sdp/blog/en/2017/12/07/samsung-dex-lifecycle-on-switching-between-mobile-and-samsung-dex-mode
* Samsung — App continuity between screens (Foldable): https://developer.samsung.com/one-ui/foldable/app-continuity.html · https://developer.samsung.com/sdp/blog/en/2021/10/18/foldable-adaptation-essentials-app-continuity-and-multi-window-handling
* Samsung — DeX SSS (Send to other display): https://ushl.samsung.com/us/support/answer/ANS10001972
* Android — Support connected displays: https://developer.android.com/develop/adaptive-apps/guides/support-connected-displays
* Android — connected display GA (QPR3): https://android-developers.googleblog.com/2026/03/android-devices-extend-seamlessly-to.html
* Önceki raporlarımız: [HANDOFF_SEAMLESS_TRANSITION.md](HANDOFF_SEAMLESS_TRANSITION.md), [TRANSITION_FRAME_GATE.md](TRANSITION_FRAME_GATE.md), `backend/scrcpy/README.md`.


---

## 8. Ölçüm ve çözüm (2026-10-15, aynı gün eklendi)

Kullanıcı "VD'yi resize edince Display 0 telefonda anlık tek kare gelip gidiyor" diye netleştirdi (yani **fiziksel panel**, PC karesi değil). Bu yüzden §4'ün Test 1–3'ünü **bizzat telefonda** koştum
(POCO 2412DPC0AG · HyperOS 3 · Android 16): bir Ayarlar penceresi açıp 8 kez resize ettim; Display 0'ı `screenrecord` ile kaydedip kareleri PyAV ile çözdüm, her karenin öncekinden farkını ölçtüm; aynı anda `logcat -b events` topladım.
Betikler: scratchpad `flash_probe.py`, `bbox.py`. Telefonun ayarları her deneyden sonra eski değerine (1,0) döndürüldü.

**Bulgu 1 — olay gerçek ve kompozit bir kare.** Resize anlarında Display 0 kaydında parlak bir kare belirip ~100 ms'de sönüyor (ortalama parlaklık 38 → 94–121 → 38). Kare görüntüsü: telefonun ana ekranının üstüne, **sol üst köşeye yapışmış, Ayarlar uygulamasının pencere içeriği** (başlık + satırlar), VD'nin kendi piksel boyutunda; sağa taşan kısım ekran genişliğinde (1220 px) kırpılıyor. Yani H1 (panel titremesi) elendi: kare gerçekten Display 0'a kompozit ediliyor.

**Bulgu 2 — resize'ın kendisi uygulamayı yeniden kuruyor (bu uygulamada).** `logcat -b events`: her resize'da `wm_relaunch_resume_activity → on_paused → on_stop → on_destroy → on_create → on_resume`, VD display id 15'te. Ayarlar `configChanges` karşılamıyor (YouTube'un aksine, §5.2).

**Bulgu 3 — kontrollü deney, hangi ayar sorumlu?** Her koşul 8 resize, aynı betik:

| Koşul | Display 0'a sızan kare |
|---|---|
| Varsayılan (hepsi 1,0) — iki ayrı koşu | **5/8** ve (animator‑yalnız koşusunda 3/8) |
| `window_animation_scale`, `transition_animation_scale`, `animator_duration_scale` = 0 (hepsi) | **0/8** |
| **yalnız `transition_animation_scale` = 0** | **0/8** |
| yalnız `window_animation_scale` = 0 | 1/8 |
| yalnız `animator_duration_scale` = 0 | 3/8 |
| **ayar yalnız her resize'ın etrafında 0 (resize öncesi aç, ~0,9 sn sonra 1,0'a dön)** | **0/8** |

**Sonuç:** Yapıştırılan metnin Mekanizma 3'ü (WM/Shell geçişinin ekran anlık görüntüsünün Display 0'a bağlanması) **bu cihazda doğrulandı** — ama nedeni "VD yüzeyinin kopması" (Mekanizma 2) değil; o kısım §2.3'te kaynak kodla çürütülmüştü ve hâlâ öyle. Sızan şey, `transition_animation_scale` ile kurulan **ekran/pencere değişimi geçiş animasyonunun anlık görüntüsüdür**; ölçek 0 iken animasyon hiç kurulmuyor. `vd_system_decorations=false`'un (H3) payı bu deneyle ayrıştırılmadı.

**Çözüm (uygulandı, cihazda uçtan uca denenmedi):** `backend/app/windows/transition_gate.py`.
* Kullanıcı kaynaklı her resize (`SessionReconfigurer.resize`, `settle=True`) `async with gate.hold()` içinde koşar; ayar **resize'dan önce** 0 yapılır, ardışık resize'lar (sürükleme) tek açma/kapama ile geçer, son resize'dan `RESIZE_TRANSITION_TAIL_S` (1 sn) sonra **kullanıcının eski değerine** döner (`null` ise silinir).
* Handoff ön-inişi (`settle=False`) kapı dışıdır: o zaten telefon ekranına gidiyor, telefondaki geçişler korunur.
* Güvenlik: asıl değer cihazdaki işaret dosyasındadır (`/data/local/tmp/opendex-transition-scale`); backend ölürse ilk sonraki `hold()` (cihaz başına bir kez `recover`) ya da `close_all()` geri yükler. Hata/zaman aşımı resize'ı **asla** bozmaz.
* Kapatma: `OPENDEX_RESIZE_SUPPRESS_TRANSITION=false` (ayara hiç dokunmaz). Maliyet: ilk resize'a ~70–90 ms (adb ile ölçüldü; daemon üzerinden daha az).
* Bilinen sınırlar: ~1 sn boyunca telefonun **kendi** pencere geçişleri animasyonsuz görünür; Workspace görev resize'ı ve DeX-içi kırpma ayrı yollar (denenmedi); HyperOS'un başka sürümlerinde davranış farklı olabilir.

Kalıcı düzeltme "uygulamayı yeniden kurmadan" mümkün değil (uygulamanın `configChanges`'i bizim elimizde değil); bu yüzden asıl sızıntı kaynağı (geçiş animasyonu) hedeflendi.

---

## 9. YouTube: aktarma / geri almada durum (2026-10-15, telefonda ölçüldü)

Deney: YouTube'u VD'de açıp Big Buck Bunny'yi oynattım; her koşuda "Telefona aktar" → 10 sn → "Geri al"; her 0,25 sn'de medya oturumu (durum, konum), YouTube pid'i, `logcat -b events` yaşam döngüsü. Betik: scratchpad `yt_probe.py`, `yt_an.py`.

| Koşul | Süreç (pid) | Oynatma | Not |
|---|---|---|---|
| 1. Paketli sürüm (YouTube oynatma korumasından MUAF) | **öldürüldü** (`am_kill … restartActivityProcess`, 13614 → 19050) | **kayboldu**, medya oturumu yok | YouTube ana sayfaya düştü |
| 2. Muafiyet kaldırıldı | sabit (22210) | `STOPPED`, konum oturumda saklı (14 988 ms) | Android etkinliği yeniden kurdu (`wm_relaunch_resume_activity`, maske `0x2804008`) |
| 3. 2 + ön-iniş KAPALI + yoğunluk yenilemesi KAPALI ("DPI uzlaştırıcı dpi değiştirmeden") | sabit | yine `STOPPED` | Yeniden kurma **yine oluyor** → neden DPI uzlaştırıcı değil, ekran değişiminin kendisi |
| 4. 2 + `PlaybackContinuity` (play + seek) | sabit (24104) | **~0,5 sn kesinti, aynı konumdan devam** (15,0 sn'de durdu → 14,9 sn'den çaldı; geri almada 24,0 → 25,1) | Telefonda yerleşim doğru; video mini oynatıcıda sürüyor |

**Neden Android etkinliği yeniden kuruyor?** Maske `0x2804008` içinde `touchscreen` (0x8), `colorMode` (0x4000) ve iki ek bit var; YouTube'un `configChanges`'i (`0x1ff0`) bunları karşılamıyor (Chrome `0x40005ffb` ile karşılıyor, o yüzden kesintisiz). VD ile fiziksel ekran bu değerlerde farklı olduğundan **her ekranlar-arası taşımada** relaunch kaçınılmaz.

**Çözüm:** `windows/playback_continuity.py` — taşımadan önce oturum OYNUYORSA anlık görüntü; taşıma bitince oturum durmuşsa `play`, ardından durma anındaki konuma `seek` (play ~2 sn geriden başlatıyor). Kullanıcının kendi durdurduğu veya kesintisiz oynayan oturuma dokunulmaz. `density_reconciler.PLAYBACK_GUARD_EXEMPT` boşaltıldı (YouTube artık oynarken süreç yeniden başlatılmıyor). Kapatma: `OPENDEX_PLAYBACK_CONTINUITY=false`.

**Sınır (dürüst):** aktarmadan sonra YouTube'un TAM SAYFA izleme görünümü **mini oynatıcıya** iniyor (etkinlik yeniden kurulunca YouTube kendi durumunu böyle geri yüklüyor); video aynı konumdan çalıyor. Tam sayfayı geri getirmek için oynatıcıya dokunmak ya da video kimliğiyle derin bağlantı gerekir (uygulama içinden açılmış videonun kimliğini oturum vermiyor). Yalnızca YouTube'da denendi; YouTube Music'te denenmedi.

### 9.1 "YouTube'un durumunu toplayıp nokta atışı açsak?" / "önce onPause'a alıp taşısak?" (telefonda test edildi, 2026-10-15)

**Hangi bilgi alınabiliyor?** Medya oturumundan: başlık, **konum, süre, oynuyor/duruyor**. Alınamıyor: **video kimliği** (`MEDIA_ID` boş; görev/yakın zamanlar intent'i gizlilik için `dat=https://www.youtube.com/...` diye kısaltılıyor; `dumpsys activity/notification/media_session/window/content/usagestats` hiçbirinde `aqz-KE-bpKQ` yok), **tam ekran mı / ne kadar kaydırılmış** (HyperOS'ta `uiautomator dump` YouTube için boş hiyerarşi döndürüyor). Kimlik olmadan `watch?v=ID&t=SN` derin bağlantısı kurulamaz; kimliği yalnızca uygulama (AssistContent `webUri`, "Paylaş → Bağlantıyı kopyala" otomasyonu) verebilir — ikisi de denenmedi.

**Önce onPause'a alıp taşımak (Ayarlar'ı üste açarak):**

| Park biçimi | Sonuç |
|---|---|
| Üste Ayarlar (varsayılan başlatma) | `userLeaving=true` → YouTube Premium **otomatik PiP'e giriyor** (`wm_enter_pip … auto-pip`). Telefona taşınca bazen tam sayfa geri geliyor (yatay VD), bazen "yuvarlak köşeli üst video + altı siyah" (dikey VD), VD'ye geri alınca "çerçeve içinde siyah" (**sizin gözleminiz doğrulandı**: PiP görevi pinned/freeform kipinde taşınıyor) |
| Ayarlar `-f 0x40000` (NO_USER_ACTION, PiP'e girmez) | Android yine yeniden kuruyor; sonuç öndeyken taşımayla **aynı**: ana sayfa + mini oynatıcı, kaydırma gidiyor |
| Öndeyken (kontrol) | ana sayfa + mini oynatıcı, kaydırma gidiyor |

→ onPause'a almak yeniden kurmayı **önlemiyor**; PiP'e girince de davranış kararsız. Önerilmez.

**Mini oynatıcı → tam sayfa:** mini oynatıcıya dokunmak (görüntüdeki konuma) **aynı videoyu tam sayfada, çalmaya devam ederek** açtı (konum 75,7 sn'de sürdü). Ama koordinata kör dokunmak güvensiz (mini oynatıcı yoksa ana sayfada rastgele içeriği açar); UI hiyerarşisi okunamadığı için varlığı doğrulanamıyor.
**Bildirimin kendi `contentIntent`'i** (`/notifications/open`, `Tier 0`): bu deneyde (uygulama telefondayken VD'ye ateşlendi) oynatma durdu ve ana sayfa + mini oynatıcı geldi → tam sayfa vermedi; temiz bir test olmadı (görev VD'ye telefon boyutunda indi). Kanıtlanmış yol değil.

**Sonuç:** koruyabildiğimiz durum = **video, konum, oynuyor/duruyor** (`PlaybackContinuity`, ~0,5 sn kesinti). Tam sayfa/kaydırma için seçenekler: (a) mini oynatıcıyı **ekran görüntüsüyle doğrulayıp** dokunmak (YouTube'a özel, kırılgan), (b) AssistContent/paylaş yoluyla video kimliği alıp derin bağlantı (denenmedi), (c) bırakmak.

### 9.2 "Duraklat → onPause → taşı → başlat" ve PiP/freeform şüphesi (telefonda, 2026-10-15)

Aktarım `windowing=fullscreen` ile gidiyor (log: `TASK MOVE:WCT … mode=1 clear=True`, `[TRANSFER] … target=fullscreen verdict=ok`, sınırlar 0,0,1220,2712).

| Koşul (aynı VD 1280×800) | Telefonda aktarmadan sonra | Not |
|---|---|---|
| Oynarken, Ayarlar üstte → **auto-PiP** (4 koşu: a,b,c,d) | "üstte küçük yuvarlak video, altı siyah" (3 ve 9. sn), geri almada VD'de ana sayfa + mini oynatıcı | PiP'in arayüzü tam ekran pencerede kalıyor (PiP→fullscreen geçişi uygulamaya "PiP'ten çık" demiyor) |
| aynı, tek koşu (`yt6`) | **tam izleme sayfası** | tekrarlanamadı (0/4) → tesadüf, güvenilmez |
| **Önce videoyu duraklat**, park yok (e) | ana sayfa + mini oynatıcı ("Continue watching", duraklatılmış) | PiP yok, siyah yok; `play` sonrası mini oynatıcı genişlemiyor |
| **Önce duraklat → Ayarlar park → taşı → başlat** (f) | aynı: ana sayfa + mini oynatıcı | PiP yok |
| Oynarken PiP'siz park (`-f 0x40000`), öndeyken | ana sayfa + mini oynatıcı | |

**Sonuç:** "Mini oynatıcıya inme" PiP/freeform'dan **gelmiyor**; PiP'e girilmediğinde de oluyor — nedeni etkinliğin yeniden kurulması (YouTube izleme sayfasını yeniden kurulumda mini oynatıcıya kısıyor). PiP/freeform'un katkısı yalnızca **siyah/yarım çerçeve** bozukluğu; duraklatmak veya PiP'siz park etmek onu ortadan kaldırıyor ama tam sayfayı getirmiyor. Tam sayfa için mini oynatıcıya dokunmak (bkz. 9.1) gerekir.
