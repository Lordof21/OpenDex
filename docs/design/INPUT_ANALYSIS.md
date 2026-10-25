> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). Product analysis of keyboard, touch and mouse input, with a roadmap.

# Klavye + Dokunmatik/Fare — Ürün Analizi (Product Owner bakışı)

Tarih: 2026-10-11 · Kapsam: frontend (`input/`, `window/VideoCanvas.jsx`, `useWheelKineticScroll.js`, `keymapper/`, `wmShortcuts.js`)
+ backend (`input/touch_control.py`, `keyboard_control.py`, `keyboard_setup.py`, `api/v1/endpoints/input.py`, `/ws/input`,
`scrcpy_launcher.ControlSocket`) · **Kod değiştirilmedi.**

Kanıt düzeyleri: **[K]** kodda doğrulandı (dosya:satır) · **[M]** mantıksal çıkarım, cihazda denenmedi · **[R]** dış kaynak.
Kullanıcı anketi/görüşmesi yok: "kullanıcı ne istiyor" kısmı rakip belgeleri, platform yönergeleri ve ürünün kendi hedeflerinden
türetildi — gerçek kullanıcı araştırması önerisi §8'de.

---

## 1. Yönetici özeti

Girdi hattının **temeli sağlam**: dokunma kalıcı WebSocket'le canlı akıyor, takılı parmak sızıntısı (`release_all`, pencere kaybı)
düşünülmüş, keymapper'ın klavye→dokunma çevirisi çalışıyor. Ama **yazma deneyimi günlük kullanıma hazır değil** ve **fare "masaüstü"
gibi davranmıyor**. Kodda doğrudan görülen, kullanıcının ilk gün fark edeceği 6 sorun:

| # | Sorun | Etki |
|---|-------|------|
| 1 | **AltGr kısayol sanılıyor** → Türkçe klavyede `@ € { } [ ] \ \| ~` yazılamıyor olabilir | E-posta/URL/kod yazılamaz |
| 2 | **PC panosu Ctrl+V ile telefona gitmiyor**; telefon→PC pano yok | "Kopyala-yapıştır" temel beklenti |
| 3 | `? : ! ( ) _ " + % & #` gibi Shift'li semboller **pano hilesiyle** yazılıyor | Telefon panosu ezilir, karakter sırası bozulabilir |
| 4 | PC **Home** tuşu Android **HOME** (ana ekran) gönderiyor | Metin alanında satır başı yerine uygulamadan çıkar |
| 5 | **Shift/Ctrl/Alt + ok/tab** değiştiriciyi kaybediyor | Metin seçme, kelime atlama, redo çalışmaz |
| 6 | Fare yalnız "parmak": **hover, metin seçme, orta/yan tuş, pinch yok** | Masaüstü uygulama hissi yok |

Rekabet açısından (scrcpy, Phone Link, DeX) en büyük fark: **bizde çok-parmak (pinch), çift yönlü pano, dosya sürükle-bırak,
gerçek fare kipi ve donanım-klavye kipi yok.** Güçlü olduğumuz yer: çoklu pencere + tuş-eşleme (oyun) + ürünün genel akıcılığı.

---

## 2. Kullanıcı kim, ne bekliyor? (Jobs-to-be-done)

| Persona | Yapmak istediği | Girdi beklentisi | Kaynak |
|---|---|---|---|
| **Ofis/öğrenci** (ana hedef: Türkçe) | WhatsApp/Telegram yazmak, e-posta, belge, tarayıcı | Hızlı, **doğru Türkçe yazı**, `@`, `?`, kopyala-yapıştır, ok/seçim kısayolları | [R] Android büyük-ekran yönergesi: standart kısayollar (Ctrl+C/V/Z), hover, sağ tık, hassas kaydırma |
| **Mobil oyuncu** | PUBG/CoD/Genshin'i klavye+fareyle | Tuş eşleme, **fareyle bakış**, çoklu parmak, düşük gecikme | [R] QtScrcpy: joystick + fare-bakışı + betikli profiller |
| **İçerik üreticisi** | Instagram/TikTok/WhatsApp Business yönetimi | Dosya sürükle-bırak, pano, uzun metin yapıştırma | [R] Phone Link: sürükle-bırak + pano (metin+görsel) |
| **Geliştirici/test** | Uygulama test, ekran görüntüsü, çoklu cihaz | Tam fare/klavye, pinch/rotate, hızlı kısayollar | [R] scrcpy: Ctrl+tıkla-sürükle = pinch/rotate |

Platformun kendisinden gelen ortak beklenti [R]: *"standart kısayolları uygula, **fare hover**'ını, **sağ tık**'ı ve **hassas
kaydırma**'yı destekle"* (Android 16 masaüstü pencereleme duyurusu). Yani kullanıcı telefonu masaüstü gibi kullanırken bu 3 davranışı
**sistemden** bekler; biz parmak simülasyonu yaptığımız için bu davranışların hiçbiri otomatik gelmiyor.

---

## 3. Bugün ne sunuyoruz? (envanter)

| Alan | Var | Nasıl | Not |
|---|---|---|---|
| Dokunma | ✅ | `/ws/input/{id}` WebSocket: down/move/up, rAF ile ~60 Hz | `touchInject.js`, `websockets.py:133` |
| Takılı parmak güvenliği | ✅✅ | `release_all`, blur/visibility, soket kapanınca UP | `TouchTracker`, `VideoCanvas.jsx:352-380` |
| Kaydırma | ✅ | Tekerlek → "kinetik" scroll darbeleri | `useWheelKineticScroll.js` |
| Sağ tık | ⚠️ | **Her zaman Android Geri** (scrcpy ile aynı varsayılan) | `useWheelKineticScroll.js:90-95` |
| Orta/yan tuş | ❌ | `e.button !== 0` ise yok sayılıyor | `VideoCanvas.jsx:383` |
| Çok parmak / pinch | ❌ | Backend ikinci parmağı biliyor (`pointer_id`), **frontend hiç göndermiyor**; Ctrl+tekerlek = `vscroll ±1.2` | `touchInject.js:177`, `useWheelKineticScroll.js:52-57` |
| Hover (imleç üstünde) | ❌ | Yok | — |
| Metin seçme (sürükle) | ❌ | Sürükleme parmak gibi kaydırır | `VideoCanvas.jsx:420` |
| ASCII yazma | ✅ | Her tuş → HTTP POST → `INJECT_KEYCODE` | `keyboardInject.js`, `input.py:80` |
| Türkçe karakter | ⚠️ | `ç ğ ı ö ş ü İ` → **panoya yaz + yapıştır** (her karakter ayrı) | `keyboard_control.py:128` |
| Kısayol | ⚠️ | Yalnız **Ctrl+tek karakter**; Shift/Alt kaybolur | `keyboardInject.js:33` |
| Adlandırılmış tuşlar | ⚠️ | Enter, Backspace, Delete, Esc, Tab, ok, Home, End, PgUp/Dn — değiştirici yok | `keyboard_control.py:57-61` |
| Pano PC→telefon | ⚠️ | `paste` olayı var ama büyük olasılıkla ölü (§4/B2) | `VideoCanvas.jsx:149` |
| Pano telefon→PC | ❌ | Kontrol soketi **yalnız yazılıyor**, cihaz mesajı okunmuyor | `scrcpy_launcher.py:63-80` |
| Dosya sürükle-bırak | ❌ | Pencerede `onDrop` yok (ayrı "Dosyalar" uygulaması var) | — |
| Tuş eşleme (oyun) | ✅ | `tap` + WASD `dpad`; paket başına, **localStorage** | `keymapperEngine.js`, `keymapStore.js` |
| Ekran D-pad | ✅ | Ok tuşları + Enter | `keyboardInject.js:20-68` |
| Pencere yöneticisi kısayolları | ✅ | Alt+Tab, Ctrl+W/M, Ctrl+Shift+F/E/D … telefona sızmaz | `wmShortcuts.js` |
| Klavye düzeni kurulumu | ⚠️ | Sert-klavye ayarına yönlendirme sihirbazı | `keyboard_setup.py`, `firstRunNotices.js` |
| Enjeksiyon hatası geri bildirimi | ❌ | Yalnızca `console.error` | `VideoCanvas.jsx:135-137` |
| Girdi gecikmesi ölçümü | ❌ | HUD yalnız video/ağ | — |

---

## 4. Kodda doğrulanan sorunlar (ayrıntı)

**B1 — AltGr, Ctrl kısayolu sanılıyor [K+R, M].** `resolveKeyEvent` ilk iş `ctrlKey && key.length===1` ise "shortcut" döndürüyor
(`keyboardInject.js:33`). Windows'ta AltGr basılınca tarayıcı hem `ctrlKey` hem `altKey` bildirir (MDN uyumluluk tablosu: "Alt ve
Control, AltGr basılınca ikisi de true"). Türkçe Q'da `@` = AltGr+Q → olay `key:'@', ctrlKey:true` → "Ctrl+@" kısayoluna dönüşür →
backend `keycode_for('@')` yok → 422 → karakter kaybolur. Aynı yol `€ { } [ ] \ | ~` için geçerli. *Tarayıcı/OS düzeyinde cihazda
denenmedi* (Tauri/WebView2 Chromium'da beklenen davranış). Çözüm yönü: `getModifierState('AltGraph')` önce kontrol, Ctrl+Alt'ı AltGr
saymak (wmShortcuts zaten `Ctrl+Alt+D`'de `code` ile aynı tuzağı biliyor).

**B2 — Ctrl+V PC panosunu telefona taşımıyor [K+M].** `onKeyDown` WM kısayolu değilse **her tuşta** `e.preventDefault()` yapıyor
(`VideoCanvas.jsx:129`); tarayıcıda `keydown`'u iptal etmek `paste` olayını da engeller. Sonuç: `onPaste` (satır 149) klavyeden
ulaşılamaz; Ctrl+V telefona "Ctrl+V tuşu" olarak gider ve **telefonun** panosunu yapıştırır. Ters yön (telefonda kopyala → PC'de
yapıştır) hiç yok: `ControlSocket` yalnız yazıyor (`_reader` hiç okunmuyor), scrcpy'nin cihaz→istemci pano mesajı atılıyor.
Karşılaştırma [R]: scrcpy "Android panosu değişince otomatik PC'ye eşitlenir", `MOD+Shift+V` PC metnini tuş olarak yazar;
Phone Link metin+görsel kopyalar.

**B3 — Shift'li semboller panoya düşüyor [K].** `ASCII_RE` (`keyboardInject.js:26`) yalnızca `a-zA-Z0-9 .,-=/;'[]\`` + `\n\t`; `! ? : ( ) _ " + * % & # $ < > | ~ ^ { }`
"special" sayılıp **SET_CLIPBOARD+paste** yoluna gidiyor. Etkiler: (a) her sembolde kullanıcının telefon panosu üzerine yazılır
(gizli yan etki), (b) parola alanları/uygulamalar yapıştırmayı engelleyebilir, (c) **sıra riski [M]**: pano+yapıştırma cihazda
yavaş, ardından gelen keycode'lar (ayrı HTTP, bkz. B6) öne geçebilir → `https://x.com/a?b=1` gibi metinlerde karakter sırası bozulabilir.
`docs/FAQ.md` bunu yalnız `ç ğ ı ö ş ü` için söylüyor; gerçekte kapsam çok geniş.

**B4 — PC "Home" tuşu = Android HOME [K].** `_NAMED_KEYCODES["home"] = 3` (`keyboard_control.py:60`) = `KEYCODE_HOME`. Satır başına gitme
(`KEYCODE_MOVE_HOME` = 122) değil; metin yazarken Home tuşu uygulamayı arka plana atar. `end: 123` doğru (MOVE_END).

**B5 — Değiştirici kaybı [K].** Ok/Tab/Backspace gibi adlandırılmış tuşlar için yalnız `key` gidiyor (`keyboardInject.js:39-41`):
Shift+Ok (seçim), Ctrl+Ok (kelime atla), Ctrl+Backspace (kelime sil), Shift+Tab (geri odak), Alt+Sol (geri) → düz tuş.
`Ctrl+Shift+Z` → `{modifiers:['ctrl'], key:'z'}` = **undo** (redo olmalı). Backend meta durumu yalnız SHIFT/ALT/CTRL biliyor
(`MetaState`), `META` (Win) ve CapsLock/NumLock yok.

**B6 — Sıralama ve verim [K+M].** Her tuş ayrı `api.post('/api/input/key')` (HTTP); `onKeyDown` bir öncekini beklemiyor
(`injectDomKeyEvent` serileştirilmemiş). Hızlı yazımda iki istek iki bağlantıdan geçip **ters sırada** işlenebilir [M]. Backend'de
`kind:"text"` (toplu, sıralı) zaten var ama frontend hiç kullanmıyor. Tuş tekrarı (`e.repeat`) da tam bir istek; basılı tutma
(oyun, ok tuşu) HTTP hızına bağlı. Key-up semantiği yok (basılı tutma = tekrar eden tam basış).

**B7 — Pinch/çok parmak yok [K].** Backend `pointer_id` ile ikinci parmak (`resolve_pointer_id(1)`) destekliyor; `WindowTouchSocket.down/move/up`
parametresi var ama `VideoCanvas` hiç ikinci parmak üretmiyor. Touchpad pinch'i (`ctrlKey` tekerlek) `vscroll ±1.2`'ye çevriliyor —
bu **yakınlaştırma değil kaydırma**; Harita/Fotoğraf/Chrome zoom'u çalışmaz. Dokunmatik PC'lerde (pointerType=touch) çoklu dokunuş eşlenmiyor;
kalem basıncı/hover da sabit (`pressure=0xFFFF`).

**B8 — Fare davranışı [K].** Tek tuş (sol), `TouchAction` yalnız DOWN/MOVE/UP (fare kaynağı değil, "sanal parmak" kimliği);
sürükleme = kaydırma → **metin seçilemez**; sağ tık her zaman Geri (bağlam menüsü/uzun-basma alternatifi yok); orta/4./5. tuş yok.
scrcpy'nin varsayılanı: sağ=Geri, orta=Home, 4.=App Switch, 5.=bildirim paneli, Shift+tık = ikincil tuşları cihaza iletir [R].

**B9 — Klavye düzeni sihirbazının etkisi şüpheli [M].** `keyboard_setup` kullanıcıyı "sert klavye düzeni" ayarına gönderiyor, ama
enjekte edilen olaylar sanal bir cihazdan (SDK enjeksiyonu) geliyor; scrcpy belgesi SDK kipinde "düzenler cihazda yapılandırılmaz"
diyor ve düzen yapılandırmasını **UHID** kipi için öneriyor [R]. Yani sihirbaz şu an etkisiz olabilir; ayrıca ASCII→keycode tablosu
**ABD düzenine** göre yazılmış (`_ANDROID_KEYCODES`). Cihazda doğrulama gerekir.

**B10 — Ekran klavyesi [M].** VD'de `display_ime_policy=local` (`scrcpy_launcher.py:324`): metin alanına odaklanınca telefonun ekran
klavyesi **VD'nin içine** açılır ve görüntünün yarısını kaplar. Fiziksel klavye kullanan kullanıcı için gereksiz; kapatma ayarı yok
(scrcpy UHID kipinde ekran klavyesini kapatabiliyor [R]).

**B11 — Sessiz hata [K].** Enjeksiyon hatası (404/409/422) yalnızca konsola düşüyor; kullanıcı "tuş çalışmadı"yı görmüyor.
Backend "Geri kökte" gibi bazı durumlarda mesaj dönüyor (`at_root`) ama tuşlar için genel bir geri bildirim yok.

**B12 — Keymapper sınırları [K].** Düğümler: `tap`, `dpad (WASD)`. Yok: **fare bakışı**, fare tuşları/tekerlek eşleme, kaydırma
(swipe) düğümü, tuş kombinasyonu, otomatik tekrar, hassasiyet, profil dışa/içe aktarma. Profiller yalnızca tarayıcı
`localStorage`'ında (başka PC/yeniden kurulumda kaybolur), koordinatlar cihaz boyutuna göre oran (yön değişince bozulur), varsayılan
şablon yok (`DEFAULT_PRESETS = { default: [] }`).

---

## 5. Rakip karşılaştırması

| Özellik | **OpenDeX** | scrcpy [R] | Phone Link [R] | DeX [R] |
|---|---|---|---|---|
| Çoklu bağımsız pencere | ✅✅ (ana fark) | ❌ (tek) | ⚠️ | ✅ |
| Gerçek fare kipi (hover, sağ/orta tık, seçme) | ❌ | ✅ (SDK/UHID/AOA) | ⚠️ ("tık = dokunma") | ✅ |
| Pinch/rotate (sanal parmak) | ❌ | ✅ Ctrl+sürükle | ✅ (dokunmatik PC) | ✅ |
| Çift yönlü pano | ❌ | ✅ otomatik | ✅ metin+görsel | ⚠️ (belge yok) |
| PC metnini tuş olarak yaz | ❌ | ✅ MOD+Shift+V | — | — |
| Dosya sürükle-bırak | ❌ | ✅ | ✅ (≤100 dosya, 512 MB) | ✅ |
| Donanım-klavye (UHID/AOA) / her dil | ❌ | ✅ UHID | — | ✅ |
| Tuş eşleme (oyun) | ✅ (tap+WASD) | ❌ | ❌ | ❌ |
| Takılı-parmak güvenliği | ✅✅ | ⚠️ | ? | ? |
| Standart kısayollar (Ctrl+Shift+Z, Shift+Ok…) | ❌ (B5) | ✅ | ✅ | ✅ |

Not: DeX/Phone Link satırları sınırlı ve kısmen eski kaynaklara dayanıyor; kesin kıyas için cihazda deneme gerekir.

---

## 6. Öneri yol haritası

Önceliklendirme: **Etki** (kullanıcının ilk gün hissi) × **Efor** (S ≤ 2 gün, M ≤ 1 hafta, L ≥ 2 hafta).

### Faz 0 — "Yanlış çalışan" düzeltmeler (S, en yüksek getiri)
1. **AltGr**: `getModifierState('AltGraph')` ile Ctrl+Alt'ı kısayoldan ayır (B1).
2. **Home → MOVE_HOME (122)**; ayrı "Android Ana Ekran" eylemi kalsın (B4).
3. **Değiştiriciyi taşı**: tüm tuşlar için `shift/ctrl/alt/meta` (B5); `Ctrl+Shift+Z` = redo.
4. **Sıralı yazma kanalı**: tuşları tek WebSocket'e (`key` mesajı, sıra garantili) taşı; REST'i bırak (B6).
5. **Hata görünürlüğü**: başarısız tuşta kısa toast/HUD rozeti (B11).
6. **Ctrl+V/C anlamı**: Ctrl+V = PC panosunu telefona koyup yapıştır; Ctrl+C = telefonda kopyala (B2'nin yarısı).

### Faz 1 — Yazma deneyimi (M–L)
7. **Shift'li sembolleri keycode+META ile yaz** (pano yolunu yalnız gerçekten klavyesiz karakterlere bırak) (B3).
8. **Pano kullanımını azalt/güvene al**: ardışık özel karakterleri tek paket halinde (kelime/parça) yapıştır; telefon panosunu
   sessizce ezmeyi bırak veya kullanıcıya göster.
9. **Donanım-klavye kipi (UHID) prototipi**: scrcpy v4.1 UHID'i zaten destekliyor [R]. DOM `code` → HID kullanım kodu; düzen telefonda
   bir kez seçilir (Türkçe Q) → AltGr, ölü tuşlar, tuş basılı tutma ve **ekran klavyesini kapatma** birlikte çözülür. **Düzeltme (kaynak
   kodu okundu, [K]):** ilk taslakta "çok VD'de yönlendirme belirsiz" demiştim. Projedeki scrcpy sunucusu
   (`backend/scrcpy/build/.../control/UhidManager.java`) Android **15+**'da UHID cihazını `addUniqueIdAssociationByPort` ile
   **ilgili sanal ekrana bağlıyor**; her pencerenin kendi sunucusu kendi VD'sine bağlı bir klavye açar. Telefonumuz Android 16 →
   yönlendirme sorunu beklenmiyor; **Android ≤14'te** ilişkilendirme yok (olaylar odaklı ekrana gider) → o sürümlerde SDK kipi
   geri-düşüş kalmalı. Hâlâ cihazda denenmeli (HyperOS'ta `/dev/uhid` izni ve ilişkilendirme).
10. **Ekran klavyesi ayarı**: "Fiziksel klavye kullanıyorum" → VD'de ekran klavyesi bastırılsın (B10).
11. **Klavye doğrulama sihirbazı**: "çğıöşü@€{}[]\|~?:!" test cümlesini yazdırıp sonucu okuyarak düzeni doğrula (B9).

### Faz 2 — Masaüstü hissi (M–L)
12. **Gerçek fare kipi** (SOURCE_MOUSE): hover, sağ/orta tık ayrı (Geri/Home yerine **ayarlanabilir**), metin seçme, hassas tekerlek
    (scrcpy SDK kipi bunları verir [R]; sunucu yama gerektirir mi değerlendirilmeli).
13. **Pinch/rotate**: `Ctrl+tıkla-sürükle` (sanal ikinci parmak — backend hazır), touchpad pinch'i gerçek iki parmak yap (B7),
    dokunmatik PC çoklu parmak, kalem basıncı.
14. **Fare yan tuşları**: 4. = Recents, 5. = bildirim paneli (scrcpy ile aynı) + ayar.

### Faz 3 — Pano ve dosya (M)
15. **Çift yönlü pano senkronu**: `ControlSocket` okuyucusu (cihaz mesajı) + otomatik/elle mod; görsel pano (Phone Link benzeri) sonraya.
16. **Dosya sürükle-bırak**: pencereye bırakılan dosya → `adb sync`/daemon `fs` ile Downloads'a, APK ise yükle.

### Faz 4 — Oyun (M)
17. **Fare bakışı** (pointer-lock + göreli hareket → sürükleme), fare tuşu/tekerlek eşleme, swipe düğümü, kombinasyon.
18. **Profil kalıcılığı + paylaşım**: backend'de sakla, dışa/içe aktar, popüler oyun şablonları; ekran yönüne duyarlı koordinat.

### Faz 5 — Ölçüm ve güven (S–M)
19. **Girdi gecikmesi telemetrisi** (tuş/dokunma → ilk değişen kare) ve enjeksiyon başarı/hata sayaçları; HUD'a "girdi" sekmesi.
20. **Ayar paneli → "Girdi"**: sağ tık eylemi, orta/yan tuş, pano modu, klavye kipi (SDK/UHID), kaydırma hızı.

### Sıralama özeti
| Madde | Etki | Efor | Sıra |
|---|---|---|---|
| Faz 0 (1–6) | Çok yüksek | S | **1** |
| Faz 1: 7, 8, 10 | Yüksek | M | 2 |
| Faz 3: 15 (pano) | Yüksek | M | 3 |
| Faz 2: 12–14 | Yüksek | M–L | 4 |
| Faz 1: 9 (UHID) | Çok yüksek ama riskli | L | 5 (önce prototip) |
| Faz 4, 5 | Orta | M | 6 |

---

## 7. Başarı ölçütleri (öneri)
* **Yazma doğruluğu:** standart test cümlesi (TR harfleri + sembolleri) 100 deneme × 3 uygulamada %100 doğru, karakter sırası bozulması 0.
* **Kısayol uyumu:** 20 standart kısayol (Ctrl+A/C/V/X/Z/Shift+Z, Shift+Ok, Ctrl+Ok …) beklendiği gibi.
* **Tuş→piksel gecikmesi p95** (şu an ölçülmüyor; önce ölçüm, sonra hedef).
* **Pano:** PC→telefon ve telefon→PC başarı oranı; telefon panosunun istenmeden ezilme sayısı = 0.
* **Hata görünürlüğü:** başarısız enjeksiyonların %100'ü kullanıcıya ya da telemetriye düşer.

## 8. Sınırlar ve sonraki adım
* Hiçbir bulgu cihazda yeniden üretilmedi (kod okuma + belge). Özellikle **B1, B2, B3-sıra, B9, B10** için 30 dakikalık bir
  deneme turu önerilir (Türkçe klavye, WebView2/Chromium, Chrome ve bir mesajlaşma uygulaması).
* Rakip karşılaştırmasında DeX ve Phone Link verileri sınırlı/eski; scrcpy verisi resmi belgelerden (güncel).
* "Kullanıcı ne istiyor": 5–8 hedef kullanıcıyla görüşme + mevcut kullanıcıların `backend/logs` ve telemetri verisinden (hangi
  uygulamada, ne kadar yazı/dokunma, hata oranı) nicel destek alınmalı; şu an öncelikler **kod bulguları + platform
  beklentisi** üzerine kurulu.
* Önceki bulgularla ilişki: takılı jest sorunu ([HANDOFF.md §4](HANDOFF.md)) farklı katman (HyperOS Home), burada kapsam dışı.

## Kaynaklar
* scrcpy — Keyboard: https://github.com/Genymobile/scrcpy/blob/master/doc/keyboard.md
* scrcpy — Mouse: https://github.com/Genymobile/scrcpy/blob/master/doc/mouse.md
* scrcpy — Shortcuts: https://github.com/Genymobile/scrcpy/blob/master/doc/shortcuts.md
* scrcpy — Control (pano, metin): https://github.com/Genymobile/scrcpy/blob/master/doc/control.md
* QtScrcpy — tuş eşleme: https://github.com/barry-ran/QtScrcpy
* Microsoft Phone Link — uygulama akışı/pano/sürükle-bırak: https://support.microsoft.com/en-us/topic/use-apps-from-your-android-device-on-your-pc-07d3d029-236e-e71f-3561-d40d7491d435
* Samsung DeX — optimizasyon: https://developer.samsung.com/samsung-dex/modify-optimizing
* Android 16 masaüstü pencereleme: https://android-developers.googleblog.com/2025/06/developer-preview-enhanced-android-desktop-experiences-connected-displays.html
* Android — bağlı ekranlar: https://developer.android.com/develop/adaptive-apps/guides/support-connected-displays
* MDN — `KeyboardEvent.getModifierState()` (AltGraph): https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/getModifierState
