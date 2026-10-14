# Telefon Isı ve Yük Koruma Raporu

**Tarih:** 2026-10-13 · **Durum:** yalnızca rapor, bu rapor kapsamında kod değişmedi · **Okuyucu:** ürün sahibi (karar için)
**Kanıt tabanı:** 11.409 gerçek yük örneği (`logs/opendex-2026101x.log*`, 11–13 Ekim, POCO 2412DPC0AG), kaynak kodu okuması, bugünkü canlı ölçümler.

---

## 1. Yönetici özeti

1. **"Otomatik ısıl kısma" bugün yok.** Kod ve belge "ısınınca her pencerenin fps/bitrate'ini düşürür" diyor; gerçekte ısıl durum değişince yalnızca bir olay yayılıyor (önyüzde rozet) ve `reallocate()` çağrılıyor. `reallocate()` ısıl seviyeyi **hiç okumuyor**, aynı girdiyle aynı sonucu üretiyor. Yani telefon "ciddi" ısıl duruma girse bile OpenDeX yükü bir birim azaltmıyor. (§3-F1)
2. **Telefon çoğu zaman şarjda** (örneklerin %80'i) **ve ekranı açık tutuluyor** (pencereler açıkken `stay_on_while_plugged_in=7`), üstüne 60 fps / 8 Mbps HEVC kodlama ekleniyor. Şarj + panel + kodlayıcı üçlüsü pil sıcaklığını yükselten tek kombinasyon. Ölçüm: pil ≥ 40 °C **%10,9**, ≥ 42 °C %0,6; en yüksek **42,2 °C**, SoC en yüksek **94,6 °C** (çok kısa). Şu an tehlikeli değil, ama bir emniyet tavanı da yok. (§3-F2, F3)
3. **Her pencere telefona ~+6…12 puan CPU ekliyor** (0 pencere %25 → 1 pencere %31 → 2 pencere %43 → 3 pencere %46) ve pil sıcaklığı 2 pencerede 36,8 → 38,3 °C. Pencere sayısına, boyuta ve fps'e hiçbir ısıl bağlı sınır yok. (§3-F2)
4. **Telefona giden komutların genel bir hız/eşzamanlılık sınırı yok.** Daemon tarafı sınırlı (6 eşzamanlı + 24 kuyruk), ama daemon yokken tüm komutlar `adb.exe` sürecine düşüyor ve orada **üst sınır yok**. API'de hız sınırı yok, devre kesici yok. (§3-F6)
5. **Kodlayıcı stres testi** tek tıkla en çok 16 eşzamanlı 1280×720@60 8 Mbps HEVC akışı açıyor; sıcaklık ya da şarj ön koşulu yok. En kötü ısıl darbe bu. (§3-F5)

**Önerim:** "Isı Sözleşmesi" adıyla 5 kademeli, histerezisli, kullanıcıya açıklayan bir termal bütçe + tek bir "Telefon Yöneticisi" (hız/eşzamanlılık/devre kesici). Önce **görünmeyen** yükler kısılır (arka plan telemetrisi, ses, aktarım), sonra **görünür** kalite (fps, bitrate), en son **durdurma**. Detay §5–§8. Karar bekleyen sorular §10'da.

---

## 2. Neden bu bir ürün konusu (kullanıcı ihtiyacı)

| Kullanıcı | Durum | İhtiyaç | İhlal edilirse |
|---|---|---|---|
| Masa başı çalışan (ana senaryo) | Telefon kabloda/şarjda, 1–3 pencere, saatlerce | Telefon **elle tutulamayacak** kadar ısınmasın, pil ömrü zarar görmesin | Güven kaybı: "uygulama telefonumu pişiriyor" |
| Oyun / video | Tek pencere, yüksek fps | Performans önce, ama güvenlik tavanı ona da uygulansın | Android zorla kısar → ani takılma, kullanıcı OpenDeX'i suçlar |
| Telefonu cebinde taşıyan | Kablosuz, şarjda değil | Pil tüketimi öngörülebilir olsun | Beklenmedik pil bitişi |
| Yeni / teknik olmayan kullanıcı | Hiçbir ayara bakmaz | **Varsayılan güvenli** olsun, sürpriz yaşamasın | İlk gün iade/olumsuz yorum |

İlkeler: (1) **Güvenlik tavanı pazarlık konusu değil**, kullanıcı ayarı onu aşamaz. (2) **Önce görünmeyen, sonra görünür, en son durdur.** (3) Her kısma kullanıcıya **neden** anlatılır, sessiz yavaşlama yok. (4) Geri dönüş **histerezisli**, titreme yok.

---

## 3. Bulgular (kanıtlı)

### F1 · Isıl kısma bir cephe (kritik)
- `main.py:861 _on_thermal(level)`: `thermal_throttle` olayı yayar; seviye `NONE/LIGHT` değilse `window_manager.reallocate()` çağırır.
- `budget_reallocator.reallocate()` → `resource_budget.allocate_fps(windows, profile, settings, custom_encoder_limit)`: **ısıl seviye parametresi yok**; sonuç yalnızca görünürlük, odak ve kodlayıcı bütçesine bağlı. Isı değişse de çıktı değişmiyor.
- `ENABLE_FPS_TIERS=False` ("canlı fps değişim maliyeti ölçülmedi"), `ENABLE_OCCLUSION_FREEZE=False`.
- Önyüz yalnızca rozet gösteriyor (`DeviceCenter.jsx`, `systemStore.thermalLevel`).
- `thermal_monitor.py` başlık/docstring'i "proactive throttling… lower every window's fps/bitrate" diyor: **belge gerçeği yansıtmıyor.** Test de yok (`reallocate`/`thermal` birlikte test edilmiyor).

### F2 · Gerçek ölçümler (11.409 örnek, 5 sn aralık)
| Metrik | Değer |
|---|---|
| Şarjda geçen süre | %80 |
| Pil sıcaklığı ≥ 38 / 40 / 41 / 42 °C | %22,9 / **%10,9** / %6,6 / %0,6 |
| Pil / deri (skin) en yüksek | 42,2 / 42,2 °C |
| SoC ≥ 70 / 85 / 90 °C | %0,8 / %0,1 / %0,1 (en yüksek 94,6 °C) |
| Deri ≥ 40 °C | %10,7 |

Pencere sayısına göre (aynı örnek kümesi):

| Açık akış | Örnek | Telefon CPU % | SoC °C | Pil °C | OpenDeX % | Sistem % |
|---|---|---|---|---|---|---|
| 0 | 2517 | 25 | 46,4 | 36,8 | 0,5 | 8,3 |
| 1 | 7211 | 31 | 47,1 | 36,3 | 1,1 | 10,1 |
| 2 | 1266 | 43 | 51,7 | 38,3 | 2,5 | 15,0 |
| 3 | 404 | 46 | 48,2 | 36,6 | 3,2 | 14,2 |
| 4–5 | 11 | 81–93 | 78–83 | 38,5 | 4,3 | 20–22 |

Not: Pil sıcaklığı kullanıcı kullanımıyla karışık (şarjda olmayan örneklerde telefon kullanılıyor). Yine de 4–5 akışta SoC 80 °C'yi aşıyor ve CPU %90'a dayanıyor: **pencere sayısı sınırsız büyürse ısı doğrusal değil, hızla artıyor.** En çok CPU yiyenler: SurfaceFlinger (3,6 ort.), system_server, Audio HAL (1,4), HWC, donanım kodek C2 (0,8), scrcpy (0,5), OpenDeX daemon (0,7).

### F3 · Panel açık + şarj + kodlama (kombinasyon riski)
- `phone_awake.py`: pencereler açıkken `stay_on_while_plugged_in=7` → ekran **uyumuyor**.
- `screen_off_while_mirroring` varsayılanı **False** → panel açık kalır. Panel + şarj + kodlayıcı aynı anda ısı üretir; panelin karartılması (ham kısma) bu üçlüyü en ucuz kıran adımdır.
- Pil sağlığı tarafında zaten eşikler var (`battery_health.py`: `BATTERY_WARM_C=40`, `BATTERY_HOT_C=45`, `SOC_WARM_C=70`, `SOC_HOT_C=85`) ama yalnızca **Pil sayfası teşhisi** için kullanılıyor, yükü etkilemiyor.

### F4 · Varsayılanlar ve sürekli iş
- Varsayılan: **60 fps, 8 Mbps, max_size 1280, HEVC (auto)**. Statik ekranda bile kodlayıcı `REPEAT_FRAME_DELAY_US=100 ms` ile saniyede ≥10 kare üretir; kodlayıcı hiç uyumaz.
- Ses: `enable_audio=True`, `audio_output_mode="pc"` → pencere **yokken bile** oturum sesi (ayrı bir ses-yalnız scrcpy süreci) PCM akıtıyor (bugün ölçülen sabit **~3,2 Mbps**). Audio HAL ve audioserver ortalamada %1,4 + %1,0.
- Daemon her 1,2 sn'de medya ve ses seviyesi sorgusu, her 4,8 sn'de pil/durum yoklar. Durum (toggle) okuması "Unable to find app for caller…" hatasıyla **bozuktu** ve her 4,8 sn'de hata JSON'u yayınlıyordu (bugün 423 olay). *Düzeltme (2026-10-13):* hata, daemon'un `IApplicationThread`'inin AMS'e bağlı olmamasından geliyordu; okuma artık `getContentProviderExternal` ile yapılıyor ve çalışıyor. Not: bu hata sürekli bir adb yedeğine **düşmüyordu** — `GET /device/states` yedek yolu yalnızca arayüz sorunca çalışır (bugün 2 kez) ve zaten daemon kabuğundan gider.
- Telemetri her 5 sn'de bir telefona sorgu atar (`TELEMETRY_INTERVAL_S=5`), ısındıkça seyrekleşmez.
- Önyüz her pencere için 500 ms'de bir `toDataURL('image/jpeg')` alır: **PC** ısıtır (telefonu değil), yine de pil/ısıl kısmada PC tarafı da düşünülmeli.

### F5 · Kodlayıcı stres testi (en sert tek darbe)
`encoder_stress_test.py`: `STRESS_TEST_MAX_ATTEMPTS=16`; her deneme bir sanal ekran + scrcpy sunucusu + kodlayıcı (proje çözünürlüğü, fps, bitrate). Yalnızca "açık pencere yok" koşulu var. **Sıcaklık, şarj, pil seviyesi ön koşulu yok**, termal kesme yok.

### F6 · Telefona hız/eşzamanlılık sınırı (önceki bulgunun özeti)
Var: daemon `ShellRunner` 6+24 (AbortPolicy "busy"), dosya havuzu, olay kuyruğu 64, resize birleştirme, keyframe 1,5 sn, backoff'lar. **Yok:** `adb.exe` eşzamanlılık sınırı (daemon düşünce tüm çağrılar buraya düşer), komut tekilleştirme, devre kesici, API hız sınırı, dokunma olayı sınırı.

### F7 · Gereksiz kodlayıcı yeniden kurulumları (ısı + bozuk kare)
- **adbd yeniden başlaması** (ekran kilidi → USB işlev değişimi) tüm scrcpy sunucularını öldürüyor; her seferinde pencereler yeniden kuruluyor, kodlayıcılar sıfırlanıyor. Bu oturumda kök neden bulundu ve telefon ayarı kapatıldı.
- **Dikey kilitli uygulamada yatay boyut** 3 sn bekleyip sanal ekranı sıfırdan kuruyordu (her seferinde yeni kodlayıcı nesli). Düzeltme yazıldı, henüz commit değil.
- Chrome aktarımında CDP yenilemesi 10–14 sn kilit tutuyordu (düzeltildi, commit'te).
- Her kodlayıcı resetinin ölçülmüş bedeli: **0,15–0,5 sn bozuk kare** + yeni anahtar kare (10–150 KB).

### F8 · Ağ koşulu ısıya dolaylı etkiler
Bozuk Wi-Fi'da yeniden iletim, kare yığılması ve keyframe istekleri radyoyu ve kodlayıcıyı daha çok çalıştırır. Hotspot'u kapat-aç yapınca düzeldi (radyo AP sorunu); uygulama içi savunma §6'da.

---

## 4. Hedef: "Isı Sözleşmesi" (ürün davranışı)

> Telefon pil sıcaklığı **43 °C'yi aşmaz**; 45 °C'ye (Android'in şarjı kestiği nokta) **hiç yaklaşmaz**. Kullanıcı hiçbir ayar yapmadan bu garanti geçerlidir. Her kısma adımı ekranda tek cümleyle açıklanır; sıcaklık düşünce kalite kademeli geri gelir.

### 4.1 Girdiler (hepsi zaten mevcut ya da kolay)
- Android ısıl durumu (daemon push): NONE/LIGHT/MODERATE/SEVERE/CRITICAL+.
- Sıcaklıklar: pil, deri, SoC (daemon `temps`, `load_monitor` örnekleri).
- Şarj durumu ve gücü (`battery_update`).
- **Eğim:** son 3 dk'da °C artış hızı (ör. > +1 °C/3 dk şarjdayken → önleyici).
- Pencere sayısı, toplam kodlanan piksel/sn, kodlayıcı bütçesi.

### 4.2 Kademeler (eşikler bu cihazın ölçümüne dayalı başlangıç; cihaz başına kalibre edilir)

| Kademe | Tetik (herhangi biri) | Çıkış (hepsi + 60 sn bekleme) | Eylem | Kullanıcıya |
|---|---|---|---|---|
| **S0 Serin** | — | — | Tam kalite | — |
| **S1 Ilık** | pil/deri ≥ 39,5 °C · Android LIGHT · şarjdayken eğim > +1 °C/3 dk | < 38,0 °C | **Yalnızca görünmeyenler:** telemetri 5→15 sn, ikon/küçük resim işleri durdur, pencere yokken oturum sesi kapat, adb "arka plan şeridi" yavaşla, dosya aktarımını bir iş ile sınırla | Rozet sarı. Metin yok (rahatsız etme) |
| **S2 Sıcak** | ≥ 41,5 °C · MODERATE · SoC ≥ 80 °C | < 40,0 °C | Odak dışı pencereler **15 fps**, odaktaki 45→30 fps, bitrate **−30 %**, kapalı/küçültülmüş pencerelerin kodlayıcısını bırak, dosya aktarımı duraklat, stres testi reddedilir | Toast: "Telefon ısındı, görüntü akıcılığı geçici olarak düşürüldü." + **[Ekranı karart]** düğmesi |
| **S3 Çok sıcak** | ≥ 43,0 °C · SEVERE · SoC ≥ 90 °C | < 41,0 °C | Tek aktif pencere (diğerleri dondurulur), 30 fps, bitrate −50 %, çözünürlük üst sınırı, ekran **otomatik karart** (kullanıcı kapatabilir), ses akışı yalnızca aktif pencere | Kalıcı uyarı: "Telefon çok sıcak. Şarjı çıkarmanız önerilir." |
| **S4 Kritik** | ≥ 45,0 °C · CRITICAL+ | < 42,0 °C **ve** kullanıcı onayı | Tüm akış **durdurulur**, pencereler park edilir (uygulamalar telefonda kalır), tüm arka plan işi durur | Tam ekran: "Telefonunuzu korumak için duraklatıldı." [Devam et] soğuyunca açılır |

Kurallar: histerezis (çıkış eşiği girişten ≥ 1,5 °C aşağı), kademeler arası **en az 60 sn** bekleme (titreme yok), yukarı atlama hemen, aşağı inme yavaş; **kullanıcı "Performans" modunda bile S3/S4 uygulanır**.

### 4.3 Kullanıcı politikası (tek ayar, Ayarlar › Sistem)
- **Dengeli (varsayılan):** yukarıdaki tablo.
- **Serin:** eşikler −1,5 °C, varsayılan fps 30, panel şarjdayken otomatik karartılır.
- **Performans:** S1/S2 yalnız uyarı (kısma yok); **S3/S4 değişmez**.

### 4.4 Eylem kataloğu ve teknik gerçekler
| Eylem | Maliyet / risk | Not |
|---|---|---|
| Pencereyi dondur/çöz (kodlayıcı bırak) | Var, güvenilir | `freeze/unfreeze` mevcut; çözünce 1 reset ≈ 0,15–0,5 sn bozuk kare |
| Bitrate'i **canlı** düşür | Reset gerekmez | MediaCodec `PARAMETER_KEY_VIDEO_BITRATE` ile `setParameters` (yama 0004'ün sync-frame çağrısıyla aynı desen) → **yeni yama 0005 `OPENDEX_BITRATE`**, ~20 satır Java |
| fps'i canlı düşür | MediaCodec'te canlı fps parametresi yok → reset ya da kaynakta kare atlama | "Açık Teknik Risk" bu. Önce **ölçülmeli**; ara çözüm: odak dışı pencereyi dondur (reset gerekmez) |
| Ekranı karart (ham, uyutmadan) | Var (`DisplayPowerController`) | Panel ısısının önemli kısmını keser; kilit/AppLock riskini taşımaz (uyku değil) |
| Arka plan telemetri/yoklama kısma | Kolay | Aralıklar ayardan okunuyor |
| Oturum sesini kes | Kolay | Pencere yokken zaten boşa akıyor |
| Şarjı sınırlama | Android izin vermez | Yalnızca kullanıcıya öneri |

---

## 5. Telefon Yöneticisi (hız ve eşzamanlılık sınırı) — ısıyla bağlantılı

Tek bir bileşen, `Adb._execute` + daemon istemcisinin önünde:

1. **Global semafor:** `adb.exe` en çok 6 eşzamanlı. İki şerit: **etkileşimli** (dokunma, pencere, handoff) ve **arka plan** (telemetri, yoklama, ikon). Etkileşimli şerit her zaman öncelikli.
2. **Tekilleştirme:** aynı komut imzası uçuştayken yeni istek aynı sonucu paylaşır; imza başına minimum aralık (örn. `dumpsys` ≥ 2 sn).
3. **Devre kesici:** aynı komut/cihaz 3 ardışık hata ya da zaman aşımı → üstel bekleme (1→2→4→…→30 sn), log'a **tek** satır.
4. **API token bucket:** telefona dokunan POST uçları (`open/resize/handoff/restart-app/input/key`) için pencere başına ~5 istek/sn, aşılırsa 429 (`Retry-After`).
5. **Dokunma birleştirme:** `move` olayları kare başına en fazla bir; `down/up` asla atılmaz.
6. **Fırtına bekçisi:** `adb_meter` verisiyle 10 sn boyunca > 20 komut/sn sürerse arka plan şeridini 30 sn dondurur ve uyarır.
7. **Isı bağı:** S1'de arka plan şeridi yavaşlar, S2'de kapanır, S3/S4'te yalnız etkileşimli şerit çalışır.

Başlangıç sayıları ölçüme göre ayarlanır; bugünkü normal akış çok altında (daemon açıkken `shell_routes` ≈ daemon 9 / adb 3).

---

## 6. Hızlı kazanımlar (günler değil saatler)

| # | İş | Etki |
|---|---|---|
| Q1 | Stres testine ön koşul: pil < 38 °C, şarj ≥ %30 ve ısıl durum NONE; deneme tavanı 16 → 8; her adım arasında kısa soğuma, pil 40 °C'yi geçerse testi durdur | En sert tek darbeyi kapatır |
| Q2 | ~~`states_get` hatasını gider~~ **YAPILDI (2026-10-13)**: durum okuması `getContentProviderExternal` ile çalışıyor | Her 4,8 sn'de gereksiz binder + istisna + hata olayı yayını bitti |
| Q3 | Pencere yokken oturum sesini kapat | 3,2 Mbps radyo + Audio HAL işi |
| Q4 | `_on_thermal` içine gerçek seviye geçir (en azından S2: odak dışı dondur) | F1'i dürüst hale getirir |
| Q5 | Yatay boyut onay düzeltmesini commit'le (yazıldı, testli) | Gereksiz kodlayıcı yeniden kurulumu |
| Q6 | `thermal_monitor.py` belge cümlelerini gerçeğe uydur (ya da Q4'ü yap) | Yanlış güven |

---

## 7. Kullanıcı deneyimi

- **Rozet:** `DeviceCenter`'daki ısı çipi 4 renk (serin/ılık/sıcak/kritik); tıklayınca "Neden yavaşladı?" kartı: hangi eşik, hangi eylem, ne zaman geri gelecek.
- **Telefon Yükü paneli:** son 2 saatlik ısı eğrisi, kademe geçişlerinin işaretleri (`load_markers` zaten var).
- **Metinler (Türkçe, kısa):** S2 "Telefon ısındı; görüntü akıcılığı geçici olarak düşürüldü." · S3 "Telefon çok sıcak. Şarjı çıkarmanız ve ekranı kapatmanız önerilir." · S4 "Telefonunuzu korumak için yayın duraklatıldı."
- **Ayarlar:** tek seçim "Isı koruması: Dengeli / Serin / Performans" + açıklama satırı; "Performans" seçilince S3/S4'ün geçerli olduğu açıkça yazılır.
- Hiçbir kademede **sessiz** davranış yok; bildirim yorgunluğunu önlemek için S1 görsel, S2+ metinli.

---

## 8. Yol haritası

| Faz | İçerik | Efor | Bağımlılık | Kabul |
|---|---|---|---|---|
| **P0** (1–2 gün) | Q1–Q6, `allocate_fps`'e ısıl kademe parametresi, S2'de dondurma, telemetri/ses kısma | Küçük | Yok | Sahte termal beslemeyle: S2'de odak dışı pencere donar, S1'de telemetri aralığı 15 sn, geri dönüşte histerezis |
| **P1** (2–3 gün) | Telefon Yöneticisi (§5) + testler | Orta | P0 | `adb.exe` eşzamanlı ≤ 6; 1000 komutluk fırtına testi telefonu aşmaz; devre kesici testi |
| **P2** (2–3 gün) | Yama 0005 canlı bitrate + S2/S3 bitrate düşürme + ölçüm: fps değişim maliyeti | Orta | APK yeniden derleme | Bitrate değişimi reset'siz (kare kaybı yok) cihazda doğrulanır |
| **P3** (2 gün) | Ayarlar politikası, rozet/“neden” kartı, ısı eğrisi | Orta | P0 | Önyüz testleri + kullanıcı gözle kontrol |
| **P4** (saha) | Cihaz kalibrasyonu: 1 saat 2 pencere şarjda soak, 30 dk oyun benzeri yük; eşiklerin ayarı | Ölçüm | P0–P2 | Pil ≥ 42 °C süresi %0, S1–S2 geçiş ≤ 2/saat |

Toplam yaklaşık 2 hafta (tek geliştirici); P0 tek başına en büyük riski (F1) kapatır.

---

## 9. Test ve ölçüm planı

- **Birim:** `allocate_fps` kademe tablosu; histerezis ve minimum bekleme; "Performans" modunda S3/S4 geçerliliği; devre kesici ve semafor; token bucket.
- **Entegrasyon (sahte daemon):** `thermal_update` dizisi 0→2→3→2→0 gönder: olay sırası, dondurma/çözme, telemetri aralığı, ses akışı.
- **Cihaz:** (a) 2 pencere + şarj 60 dk, sıcaklık eğrisi; (b) bilerek ısıt (3 pencere, 60 fps) ve S2/S3 geçişini izle; (c) stres testi ön koşul reddi.
- **Kayıt:** her kademe geçişi `load_markers` + log + olay (`thermal_stage`), dışa aktarılabilir.
- **Kabul (KPI):** pil ≥ 42 °C süresi %0 · skin ≥ 41 °C < %1 · kademe titremesi ≤ 2/saat · S3'te kullanıcıya görünür uyarı ≤ 2 sn.

---

## 10. Karar bekleyen sorular (ürün sahibi)

1. **Varsayılan politika** Dengeli mi, yoksa ilk sürümde Serin mi? (Önerim: Dengeli, S3/S4 her zaman açık.)
2. **S3'te ekranı otomatik karartmak** kabul mü? (Kullanıcı sormadan paneli kapatır; kilit riski yok ama sürpriz olabilir. Öneri: evet, toast ve "Aç" düğmesiyle.)
3. **S4'te pencereleri otomatik park etmek** mi, yoksa yalnızca uyarı mı? (Öneri: park; kullanıcı verisi telefonda kalır.)
4. **Eşikler cihaz başına mı** yoksa sabit mi? (Öneri: sabit başlangıç + P4'te model tablosu.)
5. **Şarj sırasında ısı** için kullanıcıya "kablosuz yerine kablolu / şarjı çıkar" gibi doğrudan öneriler sunulsun mu?
6. **Yama 0005** (APK yeniden derleme) kabul mü, yoksa ilk sürümde yalnızca dondurma ile mi gidelim?

---

## 11. Ek: kaynaklar (kod konumu)

- Isıl izleyici ve geri çağrı: `backend/app/windows/thermal_monitor.py`, `backend/app/main.py:861`
- Bütçe: `backend/app/windows/budget_reallocator.py`, `backend/app/windows/resource_budget.py` (`ENABLE_FPS_TIERS`, `ENABLE_OCCLUSION_FREEZE` → `config.py:236-237`)
- Eşikler: `backend/app/device/battery_health.py:30-36`
- Ekran uyanık tutma: `backend/app/device/phone_awake.py`; karartma: `backend/app/device/display_power.py`
- Varsayılanlar: `backend/app/config.py:164-169`, `backend/app/schemas/settings.py:17-39`
- Stres testi: `backend/app/windows/encoder_stress_test.py`, uç nokta `api/v1/endpoints/devices.py:62`
- Komut yürütücü: `backend/app/device/adb.py:150-191` · daemon sınırları: `ShellRunner.java`, `OpenDexDaemon.java:119-144`
- Telemetri: `backend/app/telemetry/*`, `GET /api/v1/telemetry/load`
- Ölçüm betikleri: oturum scratchpad `loadstat.py`, `loadstat2.py` (kayıtlardan saatlik/pencere-sayısı dökümü)
- İlgili raporlar: `GORUNTU_GECIS_KARELERI_ARASTIRMA.md`, `VERIYOLU_GIRISIM_VE_HIZ_ARASTIRMASI.md`
