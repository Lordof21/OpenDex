> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). End-to-end product and engineering plan: the phone's "multi audio focus" (several apps playing at once) as a checked, one-click, reversible part of the OpenDeX sound experience.

# Çoklu Uygulama Sesi — Baştan Sona Plan

Durum: 2026-10-25 · **F1–F4 uygulandı** (daemon, backend, arayüz, belgeler, testler); cihaz listesi [DEVICE_CHECKLIST.md §13](../DEVICE_CHECKLIST.md) · Kapsam: telefon yardımcısı (daemon) + backend + Ayarlar › Ses + Çok Kanallı Mikser + DeX ayarları

> **Uygulamada plandan sapmalar (bilerek):**
> * Ayrı bir onay penceresi **yok**: etkisi (tüm medya uygulamaları birlikte çalar, OpenDeX kapanınca eski hâle döner) kartın ve "bir uygulama durdu" kartının kendi metninde yazılı; ek bir pencere akışı kesmezdi. "Zil/çağrı yine öne geçer" cümlesi **doğrulanana kadar yazılmadı** (§6 F0).
> * "Duraklatma pencere"si 1,5 sn değil **2,5 sn**: oturum listesi yaklaşık saniyede bir görülür; "durdur, sonra çal" (A, B'den ÖNCE durur) yine eşleşmez.
> * Soru kartı Toast'tan ayrı küçük bir karttır (Toast tek tıkla kapanan hap, eylem düğmesi taşımaz); klavye odağını almaz, 25 sn'de kendiliğinden kapanır.
> * "Her zaman" kartta/soruda `multi_audio_focus_policy` ayarına yazılır; `PUT /audio/multi-focus` yalnız `enabled` alır (oturum onayı). Açık "Etkinleştir", "Hiçbir zaman" politikasını "Sor"a çeker.
> * Telefon bayrağı sıfırlanırsa (yeniden başlatma, başka bileşen) kira bunu bir okumada fark eder ve onay sürüyorsa yeniden uygular.
> * **F0 sonucu (POCO X7 Pro · HyperOS 3.0 · Android 16, 2026-10-25):** bayrak AÇIKKEN iki uygulama gerçekten birlikte çaldı (iki ses kanalı aynı saniyede veri üretti), AMA ikinci bir uygulama başlayınca birincisi yine durabiliyor: durmadan 3–5 ms önce Xiaomi'nin kendi odak bildiricisi (`FocusRequesterStubImpl.notifyFocusChange`) o uygulamayı bilgilendiriyor ve uygulama kendini `pauseVideo` ile durduruyor; ayrıca Android 16 ses sertleştirmesi (`AS.HardeningEnforcer`, "level: partial") bazı uygulamaların odak isteğini reddediyor (`AudioFocus DENIED`). İkisini denetleyen bir anahtar bulunamadı (Ayarlar uygulaması, framework, `settings` anahtarları tarandı). Telefondaki "Birden fazla uygulamada medya sesini ayarlayın" (`multi_app_sound_adjust`) yalnız uygulama başına ses seviyesidir. Kullanıcının gözlemi: **telefonda arka plandaki uygulamaları kapatıp RAM'i temizleyince düzeldi** (nedeni açıklanmadı) — kart ve DeX paneli bunu "bir ihtimal düzeltir" bilgisi olarak söyler. Yani özellik bayrağı doğru yönetir ama sonucu garanti etmez; "duran uygulamayı otomatik devam ettir" ayrı bir deney olarak açık. Zil/çağrı ve yeniden başlatma davranışı hâlâ doğrulanmadı.
> * `get` okuması daemon içinde `BinderDump` ile (fork yok, ≈150 KB döküm, ≤ 4 sn); kabukta `dumpsys audio | grep` yalnız yedek. Cihazda doğrulandı: okuma, `set false`, `set true`, her biri geri okumayla.

## 0. Karar özeti (kullanıcıyla kararlaştırıldı)

| Konu | Karar |
|---|---|
| Politika varsayılanı | **`Sor`** (sessiz değişiklik yok). Diğer değerler: `OpenDeX açıkken her zaman`, `Hiçbir zaman` |
| Çıkışta geri alma | **Evet, varsayılan ve kapatılamaz.** Önceki değer kaydedilir; son pencere kapanınca / kablo çekilince / backend çıkınca eski hâle döner |
| Bayat bilgi | Ayarlar › Ses kartında **"Yeniden kontrol et"** düğmesi + "Son kontrol HH:MM". Sürekli yoklama **yok** |
| Başarı varsayımı | Yok: her "Etkinleştir"den sonra durum **geri okunur** |
| Kalite çıtası | Her aşama: hedefli test + belge + i18n anahtarı + cihazda doğrulama maddesi ile kapanır |

## 1. Kullanıcı sorunu

OpenDeX'in vaadi "her uygulama kendi penceresinde, kendi sesiyle": YouTube PC'de çalarken YT Music telefonda. Android'in ses odağı bunu bozar: bir uygulama odağı alınca öbürü **durur ya da odak reddedilir** (telefon günlüğünde `AudioFocus DENIED`). Kullanıcı bunu "OpenDeX bozuk" diye yaşar; mikserdeki yönlendirme anlamsızlaşır. Telefonun **çoklu uygulama sesi** (multi audio focus) bunu kapatır. Bugün kullanıcı bunun var olduğunu, açık olup olmadığını ve işe yarayıp yaramadığını **göremiyor**.

## 2. Ölçülenler (POCO X7 Pro · HyperOS 3.0 · Android 16, 2026-10-25)

| Bulgu | Kanıt |
|---|---|
| Ayar "açık" görünür ama **uygulanmıyor** | `settings get global multi_audio_focus_enabled` = 1; `dumpsys audio` → `Multi Audio Focus enabled :false` |
| Ayarı 0 → 1 yapmak **işe yaramaz** | Sonrasında `dumpsys` hâlâ `false`: ses servisi bu anahtarı doğrudan okumuyor |
| Servisin kendi çağrısı **çalışır** | `IAudioService.setMultiAudioFocusEnabled(true)` kabuk kullanıcısıyla (tek seferlik `app_process` sınıfı, yansıma) → `dumpsys`: `true`. Kabukta `MODIFY_AUDIO_ROUTING` izni var; daemon zaten AudioPolicy için kullanıyor |
| Okuma yöntemi yok | Servis arayüzünde getter yok (`multiaudio` içeren tek yöntem `setMultiAudioFocusEnabled`). Durum yalnız `dumpsys audio` satırında |
| Kalıcılık | Çalışma zamanı bayrağı; yeniden başlatmada sıfırlanması beklenir — **F0'da doğrulanacak** |
| Aynı anda gerçekten çalma | **Doğrulanmadı** — F0'da iki gerçek uygulamayla (ör. Chrome video + YT Music) |

Sonuç: "telefon ayarlarında kapalı mı?" sorusunun cevabı **hayır, açık görünüyor; ama uygulanmıyor**, ve bunu yalnız servis çağrısı düzeltiyor.

## 3. Durum makinesi (tek doğruluk kaynağı: backend)

```
            cihaz yok
  unknown ◄──────────────  (bağlı cihaz yok / daemon yanıtsız)
     │ okuma ok
     ▼
   off ──Etkinleştir──► applying ──geri okuma true──► on
     ▲                      │ geri okuma false
     │                      ▼
     └───────── Kapat ── failed(neden)   unsupported: çağrı reddedildi / yöntem yok / daemon eski
```

* `on` iken `owner` = `opendex` (biz açtık, geri alacağız) | `phone` (zaten açıktı, dokunmayız).
* `restore_to`: bizim açtığımız durumda önceki değer (`false`). `owner=phone` iken geri alma yoktur.
* Her okuma `checked_at` (epoch s) taşır; arayüz bunu "Son kontrol" olarak gösterir.

## 4. Kullanıcı akışı (kesintisiz UX)

1. **Karşılaşma anı (en önemli).** İki medya oturumu varken biri, diğeri çalmaya başladıktan ≤ 1,5 sn içinde **OpenDeX komutu olmadan** `playing → paused` olursa ve durum `off` ise: **bir kez / oturum** toast: *"Chrome açıkken YT Music duruyor. Çoklu uygulama sesini aç?"* `[Aç]` `[Şimdi değil]` `[Bir daha sorma]`.
   * `Aç` → ilk seferde 1 adımlı onay (aşağıda) → uygula → doğrula → toast "Açıldı — OpenDeX kapanınca eski hâline döner".
   * `Bir daha sorma` → politika `Hiçbir zaman`.
   * Sezgisel yöntem (davranıştan karar, paket listesi yok): kaynak olarak ortam zaten bildiği medya oturumları; ayrı bir telefon izleyicisi eklenmez (ısı kuralı).
2. **Tek seferlik onay (yalnız ilk etkinleştirmede).** Kısa pencere: "Telefonda aynı anda birden çok uygulamanın sesi çalar. Zil/çağrı yine öne geçer *(F0'da doğrulanacak, doğrulanmadan bu cümle yazılmaz)*. OpenDeX kapanınca eski hâline döner." Seçenek: `Bu oturum için` · `OpenDeX açıkken her zaman`. Seçim politikayı belirler.
3. **Ayarlar › Ses kartı** (kalıcı yer): durum çipi, "Son kontrol 13:42", **Yeniden kontrol et**, `Etkinleştir / Kapat`, politika seçici. Kart açılınca ve cihaz bağlanınca otomatik okunur.
4. **Çok Kanallı Mikser** başlığı: durum `off` iken küçük çip "Çoklu ses kapalı" → karta gider. `on` iken çip yok (gürültü yok).
5. **DeX ayarları** (hızlı panel) › **Sistem** sekmesi: "Ses › Çoklu uygulama sesi" satırı (durum + tek tık kısayol). Ayrı bir ayar kopyası değil; aynı depoyu okur.
6. **Hata/kısmî durum:** `failed`/`unsupported` kartta nedeni söyler ve ne yapılabileceğini (HyperOS bayrağı geri çevirdi / yardımcı eski → yeniden bağlan) tek cümleyle. Asla "başarılı" gibi görünmez.

## 5. Teknik tasarım — dosya dosya

### 5.1 Daemon (`backend/java/src/com/opendex/tools/`)
* `MultiAudioFocus.java` (yeni, saf mantık ayrı): `get()` → `dumpsys audio` çıktısını satır eşlemesiyle ayrıştırır (`Multi Audio Focus enabled :(true|false)`; bulunamazsa `unknown`); `set(boolean)` → `ServiceManager.getService("audio")` → `IAudioService$Stub.asInterface` → `setMultiAudioFocusEnabled` (yansıma; yöntem yoksa `method_missing`; `SecurityException` → `permission_denied`).
* `OpenDexDaemon.java`: komut `audio_multi_focus <get|set> [true|false]` → `{type:"audio_multi_focus_result", ok, enabled?, error?}`. Protokol **eklemeli**; eski jar'da komut bilinmez → backend bunu `unsupported(daemon_old)` sayar.
* `backend/tests/test_java_pure_classes.py`: ayrıştırıcı için saf JVM testi.
* Jar `python backend/java/build.py` ile yeniden derlenir ve **commit'lenir** (Windows + Android SDK burada var; `JAVA_HOME` build.py'de ayarlanır).

### 5.2 Backend (`backend/app/`)
* `device/multi_audio_focus.py` (yeni) — `PhoneAwakeLease` ile aynı desen:
  * `read(serial)` → daemon `get`; daemon yoksa yedek `adb shell dumpsys audio | grep` ([DEVELOPMENT.md](../DEVELOPMENT.md): her komutun yedeği olur). `set` için kabukta eşdeğer **yok** → `unsupported(daemon_required)`.
  * `apply(enabled)` → kaydet-uygula-doğrula: özgün değer cihazda `global opendex_multi_focus_original` anahtarında saklanır (çökmeye dayanıklı; mevcut kayıt **ezilmez**), `set`, ardından `get` ile doğrulama; sonuç olay olarak yayınlanır.
  * `release(serial)` → `owner=opendex` ise eski değere döner ve anahtarı siler. `request_sync()` birleştirilmiş, bloklamaz.
  * Politika: `always` → pencere varken uygular, kalmayınca bırakır; `ask` → yalnız kullanıcı onayladığında "oturum kirası"; `never` → hiç uygulamaz (yine de okur).
* `main.py`: `PhoneAwakeLease` yanına bağlanır (bağlanma: `bind_device` sonrası `request_sync`; `subscribe_sessions`; **çıkış yolları**: unbind temizliği (≈ satır 489), kapanış (≈ 921, 1022) — aynı üç yerde `release`).
* `api/v1/endpoints/audio.py`: `GET /audio/multi-focus` (okur, `checked_at` ile), `POST /audio/multi-focus/recheck` (zorla okur — "Yeniden kontrol et"), `PUT /audio/multi-focus {enabled, scope: "session"|"always"}` (uygular, doğrular, 409 `not_supported`/`verify_failed`). Tümü `x-requires-device`.
* `events.py`: `multi_audio_focus_update` — `{state, owner, enabled, checked_at, error?, policy}`; payload yorumu eklenir (belgeler üretilir).
* `config.py`: `multi_audio_focus_policy: Literal["ask","always","never"] = "ask"`; `schemas`/`settings` uç noktası ve `docs/CONFIGURATION.md` üretimi.
* Güvenlik: girdi yalnız `bool`/enum; kabuk satırına istek alanı girmez.
* Isı: okuma **yalnız** bağlanma / kart açılışı / düğme / uygulama sonrası. Döngü yok.

### 5.3 Frontend (`frontend/src/`)
* `state/audioFocusStore.js` (yeni, küçük): `{state, owner, checkedAt, policy, busy}`, `refresh()` (POST recheck), `enable(scope)`, `disable()`; olaydan beslenir (`events/eventStream.js` haritasına `multi_audio_focus_update`).
* `settings/settingsModel.js` + `SettingsPanel.jsx`: **Ses** bölümüne `audioMultiFocus` kartı (durum çipi, "Son kontrol", **Yeniden kontrol et**, Etkinleştir/Kapat, politika `SegmentedControl`). Bölüm içi sıra: Yönlendirme → **Çoklu uygulama sesi** → İnce ayar → Kodlayıcı.
* `taskbar/QuickSettings.jsx` (mikser ekranı): koşullu çip. `taskbar/DexSettings.jsx` › Sistem: kısayol satırı.
* `audio/focusNudge.js` (yeni, saf): medya oturumu geçişlerinden "A durdu çünkü B başladı" kararı (zaman penceresi, kullanıcı-kaynaklı duraklatmayı eler, oturum başına bir kez); `App.jsx` içinde medya store'una abone. Saf olduğu için tablo testli.
* `components/MultiFocusConsent.jsx`: tek seferlik onay.
* i18n: yeni metinler `t('audio_focus.*')`; **tr + en yer tutucu**, diğer 18 dil toplu turda ([CEVIRI_MEMORY.md](../CEVIRI_MEMORY.md)). "Commit yap" denince çeviri sorusu hatırlatılır.
* Erişilebilirlik: durum çipi `role="status"`, düğme `aria-busy`, klavye ile tam kullanım; hareket yalnız opacity/transform.

### 5.4 Testler (yalnız hedefli)
* Backend: durum makinesi (off→applying→on/failed), özgün değer **ezilmez**, çökme sonrası geri yükleme, `owner=phone` iken geri alma yok, politika üçlüsü, doğrulama başarısızlığı → `failed`, eski daemon → `unsupported`, uç nokta sözleşmesi (`apiContract.test.js` ile eşleşir).
* Daemon: saf ayrıştırıcı testi (true/false/eksik/bozuk).
* Frontend: kart durumları + yeniden kontrol düğmesi (busy/aria), nudge kararı tablosu (pencere içi/dışı, kullanıcı duraklatması, oturum başına bir), onay akışı, DeX kısayolu aynı depoyu okur.

### 5.5 Belgeler
[SECURITY_MODEL.md](../SECURITY_MODEL.md) "What OpenDeX changes" tablosuna satır (kalıcı mı: **hayır, çalışma zamanı**; geri alınır mı: **evet**) · [AUDIO.md](../AUDIO.md) · [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) ("iki uygulama birbirini durduruyor") · [DEVICE_CHECKLIST.md](../DEVICE_CHECKLIST.md) · `python scripts/docgen.py` (API/CONFIG/olaylar/protokol blokları) · [CHANGELOG.md](../../CHANGELOG.md).

## 6. Aşamalar ve kabul ölçütleri

| Aşama | İçerik | Kabul |
|---|---|---|
| **F0** | Cihazda (kullanıcı + ben): iki uygulama gerçekten birlikte çalıyor mu; zil/çağrı davranışı; yeniden başlatmada bayrak; HyperOS bayrağı kendiliğinden geri çeviriyor mu | Sonuçlar bu belgeye işlenir; onay metni ona göre yazılır |
| **F1** | Daemon `get` + backend `GET`/`recheck` + kart (yalnız durum + **Yeniden kontrol et**) | Kart açılınca ≤ 1 sn'de taze durum; düğme güncelliyor; telefon **değişmiyor** |
| **F2** | Daemon `set` + kaydet/uygula/doğrula/geri al + politika + onay + SECURITY_MODEL | "Etkinleştir" sonrası gerçekten `true` okunur; çıkışta eski değer; çökme sonrası geri yükleme |
| **F3** | Nudge toast + mikser çipi + DeX ayarları kısayolu | Karşılaşma anında bir kez sorar; reddedince bir daha sormaz; durum her yerde aynı |
| **F4** | Belgeler, i18n turu (istenince), cihaz listesi, jar commit | Docs testleri yeşil, hiçbir yerde yoklama döngüsü yok |

## 7. Riskler

* **Sistem geneli etki:** tüm medya uygulamaları birlikte çalar (telefonu doğrudan kullanırken de). Onay + geri alma bu yüzden şart.
* **HyperOS bayrağı geri çevirirse** "Uygulanıyor" kalıcı olmaz: doğrulama okuması + kart nedeni bunu yakalar; bir sonraki pencere değişiminde yeniden uygulanır (en çok bir kez/olay).
* **Nudge sezgisi** yanlış pozitif verebilir (kullanıcı kendi duraklattı): ek koruma = OpenDeX'in kendi komutlarını ve 5 sn içindeki kullanıcı eylemlerini eler, oturum başına tek toast.
* **Daemon eski:** özellik kendini kapatır, kart "yardımcıyı güncelleyin" der; diğer ses işlevleri etkilenmez.
* **Bu belgedeki "doğrulanmadı" satırları** F0'dan önce kullanıcıya vaat olarak yazılmaz.
