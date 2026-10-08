> **Language note:** Turkish (translation is on the [roadmap](../ROADMAP.md)). A product-requirements document for a *game mode* of mirror windows. Phase 0 (input safety) is implemented; the rest is a plan, not a promise.

# Oyun Modu — Ürün Gereksinimleri (Sanal Ekran Pencereleri)

> Durum: **Gereksinim dokümanı — kod değişikliği yok.** Bu belge bir uygulama planı değil; "ne ve neden" belgesidir.
> Hedef kitle: ürün, frontend, backend ve telefon-tarafı (Java daemon / scrcpy) ekipleri.
> Yöntem: önce mevcut kod okundu (bulgular §1, dosya:satır ile), sonra gereksinimler yazıldı. "Doğrulanacak" etiketi,
> kodda veya belgede kanıtı olmayan, **cihazda/WebView'da ölçülmeden doğru kabul edilmeyecek** varsayım demektir (§9 Spike'lar).

---

## 0. Özet (bir sayfada)

**Problem.** Bugün sanal ekran (VD) penceresi *"telefonu bir pencerede göstermek ve dokunmayı fareyle taklit etmek"*
için tasarlı. Bir oyuncu için bu üç şeyi bozar: (1) oyun *tek parmakla* oynanıyor — joystick ile ateş aynı anda
olmuyor; (2) fare imleci pencereden kaçıyor, kamera çevirmek mümkün değil; (3) pencere kısayolları oyun tuşlarıyla
çakışıyor (**Ctrl+W pencereyi kapatıyor**, Esc tam ekrandan atıyor; FPS düzenlerinde Ctrl = çömel, W = ileri
sık bir kombinasyondur).

**Karar önerisi.** "Oyun Modu"nu pencere başına açılan, uygulama paketine bağlı **profilli** bir mod olarak kurmak:

| Sütun | Ne verir |
|---|---|
| **Giriş motoru** | Gerçek çoklu dokunuş (10 işaretçi), sıfır ölü bölge, takılı-parmak güvenliği |
| **İmleç** | 3 durum: *Serbest* · *Yakalı (PUBG gibi, imleç daima oyunu izler)* · *Ctrl basılıyken geçici serbest* |
| **Oyun Çubuğu** | Başlık çubuğunun yerine geçen, **şeffaf, kendiliğinden saklanan**, oyun ekranını hiç kapatmayan kontrol şeridi (küçült / büyüt / tam ekran / imleç / tuş düzeni) |
| **Tuş düzeni** | Profil başına WASD-joystick, bakış (fare), ateş / nişan, tuş yakalama; mevcut ama **ulaşılamayan** keymapper'ın tamamlanması |
| **Performans** | Oyun profili: arka plan efektleri kapalı, çözünürlük kilitli, sade HUD |

**Önce çözülmesi gereken 3 şey (F0 — oyun modundan bağımsız, bugünkü hatalar) — ✅ F0 tamamlandı, bkz. §11.1:**
1. ✅ "Kontroller" yön okları **hiç çalışmıyordu** (backend 422 veriyor, UI sessizce yutuyordu) — G-0.
2. ✅ Keymapper'ın düzenleyicisini açan **hiçbir yer yoktu** — özellik fiilen ölüydü — G-3.
3. ✅ Bir WS kopması telefonda **parmağı basılı bırakıyordu** — G-7.

**Açık ürün kararları (cevabınız gerekiyor):** §10.

---

## 1. Mevcut durum denetimi

Her satır kodu okuyarak çıkarıldı. "Kanıt" sütunu doğrulanabilir.

### 1.1 "Kontroller" gerçekte ne? (hub → Kontroller)

Başlık çubuğundaki ⚙ **Pencere Hub'ı** (`TitleBar.jsx:112-130`) açılır; içindeki **Kontroller** karosu
(`HubPanel.jsx:94-99`, `Gamepad2` ikonu) bir **oyun kolu değil**: `WindowFrame.jsx:531` ile `win.visualControls`
bayrağını çevirir ve `VisualControls.jsx`'teki **Android TV tarzı bir yön tuşu (D-pad) + Seç** kaplamasını
(`WindowFrame.jsx:854-871`) gösterir. Yani:

- İkon (gamepad) ile işlev (TV uzaktan kumandası) **uyumsuz** — kullanıcıya yanlış vaat veriyor.
- Oyun için bir anlamı yok; oyun modu bu karoyu **yeniden adlandırıp** ("Yön tuşları") ayrı bir "Oyun" bölümü açmalı (§6).

### 1.2 Bulgu tablosu

| # | Bulgu | Kanıt | Oyuncuya etkisi | Sınıf |
|---|---|---|---|---|
| **G-0** | D-pad okları `kind:'dpad'` yolluyor; backend şeması yalnız `keycode/char/text/shortcut` kabul ediyor → **422**, UI `.catch(() => {})` ile yutuyor. Yalnız "Seç" (`keycode:enter`) çalışıyor. (Pydantic ile doğrulandı.) | `WindowFrame.jsx:856-862` · `endpoints/input.py:31` | Oklar tıklanıyor, hiçbir şey olmuyor, hata yok | ✅ Giderildi (F0) |
| **G-1** | **Tek parmak.** Tüm dokunuşlar aynı sabit işaretçi kimliğiyle gidiyor; soket mesajında kimlik alanı yok. | `touch_control.py:22,62` · `touchInject.js:155-165` | Joystick + ateş + kamera **aynı anda olamaz** — oyunun temel şartı | **Engelleyici** |
| **G-2** | Keymapper yalnız `tap` ve `dpad(WASD)`; WASD sabit, okla birlikte hard-coded; fare tuşu / tekerlek / bakış yok. Her tuş tek parmağı paylaşıyor (G-1). | `keymapperEngine.js:25-70` | Gerçek bir oyun profili kurulamaz | Eksik |
| **G-3** | Keymapper düzenleyicisini (**Tuş Düzenleyici**) açan kod yok: `setEditWindowId` yalnız `null` ile çağrılıyor. Hub'da, başlıkta, menüde giriş yok. Testi de yok. | `VideoCanvas.jsx:511` · repo geneli grep | Özellik fiilen **ulaşılamaz** | ✅ Giderildi (F0) |
| **G-4** | Tuş seçimi sabit 17 tuşluk listeden; "tuşa bas" yakalaması yok. Eşleme `event.key` ile — **düzen bağımlı** (AZERTY'de WASD ≠ fiziksel WASD). Profiller yalnız `localStorage`, paket başına tek; dışa/içe aktarma yok. | `KeymapperOverlay.jsx:19-21` · `keymapperEngine.js:7-10` · `keymapStore.js:9` | Başka düzen/başka PC'de kaybolur | Eksik |
| **G-5** | **WM kısayolları oyun tuşlarıyla çakışıyor:** Ctrl+W → pencereyi kapat, Ctrl+M → küçült, Ctrl+Shift+F/E/D, Alt+Tab, Ctrl+Alt+Ok. **Esc → tam ekrandan çık** (koşulsuz). Ctrl'in çömelme, W'nin ileri olduğu yaygın FPS düzenlerinde çömelerek ilerlemek = **pencere kapanır**. | `wmShortcuts.js:26-45` · `shortcutsSlice.js:97-104` | Oyun ortasında istemsiz çıkış/kapanma | **Engelleyici** |
| **G-6** | Tuş-olayı yolu: eşlenmeyen her tuş **HTTP POST** (tuş başına), `DOWN → 5 ms → UP`; **basılı tutma yok** (keyup'ta bir şey gönderilmez). | `keyboardInject.js:67-97` · `keyboard_control.py:119-125` | Koşma/çömelme/nişan "basılı tut" tuşları çalışmaz; gecikme yüksek | Eksik |
| **G-7** | `/ws/input` kapanınca (`finally`) **UP gönderilmiyor**. Ön yüzde `blur` yalnız *etkin bir fare sürüklemesi* sırasında bırakır; `visibilitychange` yok; keymapper'ın WASD joystick durumu (`activeDpadState`) odak kaybında **hiç temizlenmiyor** (W basılıyken pencere odağı giderse keyup gelmez → sanal parmak basılı kalır). | `websockets.py:181-184` · `VideoCanvas.jsx:366-375` · `keymapperEngine.js:5,48-52` | Ağ takılırsa **parmak telefonda basılı kalır** (karakter yürümeye devam eder) | ✅ Giderildi (F0) |
| **G-8** | **8 px ölü bölge:** ilk hareket, 8 px aşılana dek gönderilmiyor; hareket `rAF` ile seyreltiliyor, `getCoalescedEvents` yok. | `VideoCanvas.jsx:39,385-395` | Nişan ince ayarı (küçük sürükleme) kayboluyor, ilk kayma sıçrıyor | Eksik |
| **G-9** | Yalnız sol tuş (`button !== 0` → çık). **Sağ tık = Android Geri.** Tekerlek = kinetik kaydırma, Ctrl+tekerlek = sıkıştırma taklidi. | `VideoCanvas.jsx:341` · `useWheelKineticScroll.js:90-95,53-58` | PUBG'de sağ tık = nişan; burada Geri → oyundan/menüden çıkar | **Engelleyici** |
| **G-10** | İmleç yakalama yok: `requestPointerLock`, Keyboard Lock, `movementX/Y` kodda **hiç geçmiyor.** İmleç sürekli `cursor-default`. | repo geneli grep | Kamera çevirme imkânsız; imleç pencereden çıkar | Eksik |
| **G-11** | Başlık çubuğu **44 px, %95 opak**, hover şeridi 12 px ve `pointer-events-auto` (üst kenardaki oyun tuşlarının tıklamasını yutar). Tam ekranda bile hover'la 44 px'lik opak şerit iner. Dokunmatik giriş yolu yok. | `TitleBar.jsx:87` · `WindowFrame.jsx:807-820` | Oyun HUD'ının (harita/pusula) üstünü kapatır, kenar tıklamalarını yer | UX |
| **G-12** | Tam ekran = **uygulama içi CSS modu**; işletim sistemi tam ekranı ayrı (Taskbar F11). Tam ekran geçişi, dinamik çözünürlük açıksa **sanal ekranı yeniden boyutlandırıyor** (`commitResize`). | `geometrySlice.js:222-252` · `Taskbar.jsx:505` | Oyun açıkken çözünürlük/DPI değişimi → uygulama yeniden yapılanabilir/yeniden başlayabilir | Risk |
| **G-13** | Her oyun penceresinde sürekli arka plan işi: 500 ms'de bir `toDataURL('image/jpeg')` (küçük resim + ambiyans), `blur-3xl scale-150` arka plan, SVG keskinleştirme filtresi (`adaptive` varsayılan). | `VideoCanvas.jsx:181-202,433-437,460-464` | Oyuncunun PC'sinde gereksiz GPU/CPU; kare düşüşü | Performans |
| **G-14** | Gecikme HUD'ı **her zaman görünür**, sağ üst, opak `bg-scrim` hap; kısayol F8 ana `window`'a bağlı (PiP belgesinde tetiklenmemesi beklenir — doğrulanacak); 1% low yok. | `LatencyHudOverlay.jsx:42-73,98-105` | Oyuncuyu rahatsız eder; PiP'te kapatılamayabilir | UX · ✅ F8/PiP kısmı giderildi (F0) |
| **G-15** | Gamepad API'ye (`getGamepads`) hiç dokunulmuyor. | repo geneli grep | Kol ile oynama yok | Eksik |
| **G-16** | **Rahatsız etme yok:** Android heads-up kartları tam ekran pencerenin (`z 100000`) üstünde çiziliyor (`z 100050`). | `zIndex.js:29` · `HeadsUpToast.jsx` | Oyun ortasında bildirim kartı | UX |
| **G-17** | PC'deki **Home** tuşu backend'de `"home": 3` → Android `KEYCODE_HOME` (launcher'a dönüş); metin imleci "satır başı" (`KEYCODE_MOVE_HOME`=122) değil. `End`/`PageUp`/`PageDown` doğru eşleniyor. Niyetli olup olmadığı **doğrulanacak**. | `keyboard_control.py:60` | Metin alanında Home'a basmak uygulamayı arka plana atabilir | Şüphe |

### 1.3 Zaten iyi olanlar (korunacak / yeniden kullanılacak)

- Video hattı gecikmeye ayarlı: WebCodecs `optimizeForLatency:true`, `desynchronized:true` tuval (`videoDecoder.js:45,162`).
- Dokunuş zaten kalıcı **WebSocket** üzerinden akıyor (REST'ten daha iyi) — çoklu dokunuş için taşıyıcı hazır.
- scrcpy dokunma kablo biçimi **`u64 pointerId` taşıyor** (`touch_control.py` başlığı) — protokol çoklu dokunuşa açık.
- Dürüst HUD felsefesi (ölçülemeyeni uydurmama) ve gerçek ölçümler (`streamStats`, `rttProbe`).
- Pencere başına ses mixer'ı ve odak (duck) mantığı **opt-in** (`appAudioMixer.js:180`) — oyun sesi varsayılan olarak kısılmıyor.
- Tek karar noktaları: `windowModel.isHeaderHidden`, `wmShortcuts.matchWmShortcut`, `fitModes.resolveFit`, `escapeStack`.
  Oyun modu yeni "karar merkezleri" açmayacak, bunları **genişletecek**.
- Isı/yük telemetrisi (`deviceThermal`, Telefon Yükü) ve `isWirelessLink` — oyun HUD'ı ve ön kontrol için hazır veri.

---

## 2. Kullanıcı ve ilkeler

**Birincil kullanıcı:** telefonundaki mobil oyunu (PUBG Mobile, Call of Duty Mobile, Genshin, MOBA'lar, yarış) PC'de,
klavye + fare ile oynamak isteyen oyuncu. İkincil: pencereli oynayıp yanında sohbet/yayın açan oyuncu.

**Tasarım ilkeleri** (çatışmada üstteki kazanır):

1. **Oyun asla ikinci planda kalmaz.** Hiçbir kontrol, oyunun tıklamasını/dokunuşunu yutmaz; görünmezken *tıklanamaz*.
2. **Kaza ile çıkış yok.** Oyuncunun bildiği tuşlar (Ctrl, Shift, Esc, Alt, W…) oyun modunda oyuna aittir.
3. **Her durumdan tek jestle çıkış var** ve öğretilmiş (kaçış akoru §4.5).
4. **Görmeden de çalışır.** Çubuk saklıyken bile ne yapılacağı bellidir (Ctrl = imleç gelir, çubuk gelir).
5. **Dürüst ölçüm.** HUD'da uydurma sayı yok; "—" yazılır.
6. **Evrensel, özel durum yok.** Oyun adına `if` yok; her şey *profil verisi* ve *tek mod bayrağı* ile.
7. **Geri alınabilirlik.** Oyun modu bozulursa tek ayarla bugünkü davranışa dönülür (bayrak kapalı = bugünkü ürün).

---

## 3. Kavram modeli

```
Oyun Modu  = pencere başına bayrak (win.gameMode) + paket başına Oyun Profili
Oyun Profili = { düğümler[], fare ayarı, bırakma tuşu, çubuk ayarı, performans seti, çözünürlük kilidi }
```

**Giriş yolları:** (a) Oyun Çubuğu/Hub'dan manuel; (b) uygulama oyun ise (Android `ApplicationInfo.category == CATEGORY_GAME`,
**doğrulanacak**; daemon raporlar) pencere ilk odaklandığında *tek satırlık öneri*: "Bu bir oyun gibi görünüyor — Oyun Modu'nu aç?"
**Sessizce otomatik açılmaz** (Ctrl+W vb. davranış değişir, kullanıcı sürpriz yaşamamalı).

**Durum makinesi (imleç):**

```
            ┌──────────── Ctrl basılı (veya Çubuk ▸ Serbest) ────────────┐
            ▼                                                            │
        SERBEST ──── tıkla / Çubuk ▸ Yakala ────► YAKALI ◄── Ctrl bırak + tıkla
   (imleç görünür,                          (imleç gizli, göreli fare,
    tıklama = dokunuş)                       tıklama = ateş/nişan düğümü)
            ▲                                                            │
            └──────── Kaçış akoru / pencere odak kaybı / Esc* ───────────┘
```
`*` Esc'in anlamı §4.5'te.

---

## 4. Gereksinimler

Öncelik: **P0** = Oyun Modu'nun var olması için şart · **P1** = "tam deneyim" için şart · **P2** = zenginleştirme.
Her gereksinimin **Kabul** satırı ölçülebilir olmalıdır.

### 4.A İmleç ve fare (kullanıcının istediği "PUBG gibi" davranış)

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| A1 | **Üç imleç durumu:** *Serbest*, *Yakalı*, *Geçici serbest (Ctrl basılı)*. Durum Oyun Çubuğu'nda ve pencerenin köşesinde 1 sn'lik toast ile gösterilir ("İmleç yakalandı · Serbest bırakmak için Ctrl"). | P0 | Üç durum arasında geçişte imleç kaybolma/titreme yok; durum her zaman görsel olarak okunur |
| A2 | **Yakalı durumda imleç oyun penceresini daima izler:** Pointer Lock (`unadjustedMovement:true`, ivme yok) + göreli hareket. İmleç pencere dışına **çıkamaz**. | P0 | 5 dk kesintisiz fare hareketinde imleç pencereden çıkmaz; ivme (acceleration) uygulanmaz |
| A3 | **Ctrl basılı = geçici bırakma:** basıldığı anda imleç serbest, Oyun Çubuğu görünür; bırakılınca bir sonraki tıklama yeniden yakalar ("Yakalamak için tıkla" ipucu). Bırakma tuşu ayarlanabilir (Ctrl varsayılan; Alt, Sol Shift seçenekleri). | P0 | Ctrl→imleç gecikmesi < 100 ms; Ctrl'i profilde bir eyleme atamaya çalışınca **çakışma uyarısı** |
| A4 | **Kilit (sabit serbest):** kullanıcı imleci kalıcı serbest bırakabilir (Çubuk ▸ İmleç ▸ Serbest). | P0 | Mod kalıcı; yeniden başlatmada profilde hatırlanır |
| A5 | **Fare bakışı → kamera:** göreli hareket, profildeki *bakış bölgesi* içinde sanal bir parmağı sürükler; bölge kenarına yaklaşınca parmak **yeniden merkezlenir** (bırak-bas), kare kaybı olmadan. Hassasiyet X/Y ayrı, Y ters çevir, nişan (ADS) çarpanı. | P0 | 1000 Hz farede girdi kaybı yok (delta'lar birikir, kare başına tek gönderim); yeniden merkezleme sırasında kamera sıçraması gözle görülmez |
| A6 | **Fare tuşları:** sol/sağ/orta/X1/X2 ve tekerlek yukarı/aşağı birer **düğüm tetikleyicisi** olabilir (ateş, nişan *basılı tut* ya da *aç/kapa*, silah değiştir). Oyun modunda sağ tık **Geri değildir**. | P0 | Sağ tık oyun modunda Android Geri üretmez; Geri yalnız Çubuk/kısayol ile |
| A7 | **İmleç görünümü:** Serbest'te normal; Yakalı'da gizli; isteğe bağlı *nişangâh* (nokta/artı, boyut/renk/opaklık). Nişangâh *oyunun kendi nişangâhının yerine geçmez*, yalnızca isteğe bağlı yardımcıdır. | P2 | — |
| A8 | **Yakalama desteklenmiyorsa zarif düşüş:** WebView'da Pointer Lock yoksa/reddedilirse Tauri'nin imleç-kıstırma API'sine (`setCursorGrab`, **doğrulanacak**) düş; o da yoksa kullanıcıya açık mesaj, mod *Serbest*'te çalışır. | P0 | Her ortamda (§9 S1) en az bir yol çalışır; sessiz başarısızlık yok |

### 4.B Giriş motoru (çoklu dokunuş ve dayanıklılık)

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| B1 | **Çoklu dokunuş:** soket mesajına `id` (0–9) eklenir; arka uç bunu scrcpy `pointerId` alanına eşler. Kimlikler **düğümlere sabit atanır** (örn. 0=fare/ana, 1=joystick, 2=bakış, 3..=dokunma düğümleri) — "ilk gelen alır" yok. Üst sınır 10 (Android/scrcpy sınırı, **doğrulanacak**). | P0 | Joystick + bakış + ateş **aynı anda**; iki tuşa aynı anda basınca ikisi de tetiklenir |
| B2 | **Geriye uyum:** `id` yoksa bugünkü tek-parmak davranışı. Bayrak kapalıyken hiçbir şey değişmez. | P0 | Mevcut `touchInject` testleri değişmeden geçer |
| B3 | **Takılı-parmak güvenliği:** (i) ön yüz: pencere `blur`, `visibilitychange`, Ctrl-bırakma, mod değişimi, pencere donma/küçültme → **tüm aktif işaretçilere UP**; (ii) arka uç: `/ws/input` kopunca/pencere kapanınca/dondurulunca **o soketin açık parmaklarına UP**; (iii) hata ayıklama: açık parmak sayısı HUD'da. | P0 | Soketi zorla kopar → telefonda 200 ms içinde tüm parmaklar kalkar (G-7 regresyon testi) |
| B4 | **Ölü bölge yok (oyun modunda):** ilk hareket anında gönderilir; hareket olayları `getCoalescedEvents` ile birleştirilip kare başına en fazla bir gönderim, **ama hiç delta kaybedilmeden**. | P0 | 8 px altı sürükleme telefonda görülür; hareket gönderim sıklığı ≈ ekran yenileme hızı |
| B5 | **Basılı tutma klavye yolu:** oyun modunda eşlenmeyen tuşlar da `keydown→DOWN`, `keyup→UP` olarak **WS üzerinden** gider; HTTP POST yolu yalnız oyun dışı. `e.repeat` filtrelenir. | P1 | Tuşu basılı tutmak telefonda basılı tutma üretir; tuş başına HTTP yok |
| B6 | **Düzen bağımsız eşleme:** tüm eşlemeler `event.code` (fiziksel konum) ile; ekranda `event.key` etiketi gösterilir. | P0 | AZERTY/TR-Q/Dvorak'ta "W konumu" ileri gider |
| B7 | **Sıra ve gecikme bütçesi:** giriş mesajları tek soket, sıralı; sıkışmada eski `move`'lar birleştirilir (koalesans) ama `down/up` asla düşmez. | P1 | Ağ sıkışmasında bile `down/up` sırası bozulmaz |
| B8 | Geri basınç: giriş kuyruğu sınırlı; sınır aşılırsa yalnız `move` birleştirilir, HUD'da "Giriş gecikmeli" uyarısı. | P1 | — |

### 4.C Tuş düzeni (keymapper'ı tamamlama)

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| C1 | **Erişilebilir giriş:** Oyun Çubuğu'nda "Tuş düzeni" düğmesi + Hub karosu → düzenleyiciyi açar (G-3). Düzenleyici **canlı video üstünde** çalışır. | P0 | Düzenleyiciyi bulmak ≤ 2 tık |
| C2 | **Düğüm türleri:** `tap` (sanal basış), `hold` (basılı tut), `toggle` (aç/kapa, ADS), `joystick` (4 tuş, **tuşları yeniden atanabilir**), `look` (fare bakışı bölgesi), `wheel` (tekerlek → iki düğüm), `swipe` (kısa kaydırma). | P0 (tap/hold/joystick/look) · P1 (toggle/wheel) · P2 (swipe) | Her tür düzenleyicide eklenebilir, taşınabilir, silinebilir |
| C3 | **Tuşa bas ile yakalama:** listeden seçmek yerine "Bir tuşa / fare tuşuna bas". Çoklu atama ve çakışma denetimi (aynı tuş iki düğümde → uyarı). | P0 | Herhangi bir fiziksel tuş/fare tuşu atanabilir; çakışma görülür |
| C4 | **Düzenleyici UX:** sürükle-bırak + ok tuşlarıyla piksel-hassas taşıma, düğüm boyutu sürgüsü, yan panelde liste, **Geri Al/Yinele**, "Kaydet / Vazgeç" (şu an yalnız Kaydet var). Koordinatlar cihaz oranına bağlı (`rx, ry`) — pencere boyutu değişse yerinde kalır. | P0 | Pencereyi yeniden boyutlandırınca düğümler video üzerinde aynı noktada kalır |
| C5 | **Profiller:** oyun başına birden çok profil ("FPS", "Sürüş"), adlandırma, kopyalama, **JSON dışa/içe aktarma**, paket başına varsayılan. Depolama yalnız `localStorage` değil → arka uç (`settings.db`) *(yeni PC'de de gelsin)*. | P1 | Uygulama yeniden kurulsa da profil geri gelir |
| C6 | **Kenar durumlar:** düğümün cihaz ekranı dışına düşmesi (yeniden boyut sonrası) kırpılır; döndürme (dikey↔yatay) için **iki ayrı yerleşim** (oyunlar sık sık yatay). | P1 | Yatay/dikey geçişte profil doğru yerleşimi seçer |
| C7 | **Hazır başlangıç şablonları** (genel FPS, genel MOBA, yarış): kullanıcı sıfırdan başlamaz. *Oyun adına özel kod yok — yalnız veri.* | P2 | — |
| C8 | **Çıkarılanlar (kapsam dışı, bilinçli):** otomatik ateş, makro/art arda hızlı basış, geri tepme telafisi. Hile/ToS riski (§8). | — | Hiçbir profil bu özellikleri üretemez |

### 4.D Oyun Çubuğu — şeffaf kontrol şeridi (kullanıcının "şeffaf olsun, rahatsız etmesin" isteği)

Oyun modunda 44 px'lik opak başlık çubuğu **yerine** *Oyun Çubuğu* gelir.

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| D1 | **Düğmeler:** `Küçült` · `Büyüt / Önceki boyut` · `Tam ekran` · `İmleç (Yakala/Serbest)` · `Tuş düzeni` · `HUD` · `Ses` · `Daha fazla (Hub)` · `Oyun modundan çık`. Küçült/Büyüt/Tam ekran, mevcut `useOsWindowController` eylemlerini **yeniden kullanır** (yeni mantık yok). | P0 | Eylemler başlık çubuğuyla birebir aynı sonucu verir |
| D2 | **Boşta görünmez:** bekleme opaklığı **%0–%100 ayarlanabilir** (varsayılan %0 → yalnız ince bir "tutamak" çizgisi %25). Fare üst kenara (≈ 56 px) yaklaşınca **120 ms** ile belirir (yaklaşık %88 opak + `backdrop-blur`), etkileşim bitince **1,8 sn** sonra **200 ms** ile kaybolur. | P0 | Boşta oyun görüntüsünü %0 örter (tutamak hariç) |
| D3 | **Tıklamayı yutmaz:** görünür değilken çubuk ve "hover şeridi" `pointer-events:none`; yaklaşma, **pencere düzeyinde `pointermove`** ile algılanır (DOM şeridi yok). Böylece üst kenardaki oyun tuşları (ör. ayarlar) çalışır (G-11). | P0 | Üst kenardaki 12 px'e tıklama oyuna ulaşır |
| D4 | **Ctrl ile birlikte gelir:** Ctrl basılı → imleç serbest → çubuk otomatik görünür; Ctrl bırakılınca (ve çubukla etkileşim yoksa) kaybolur. Oyuncu imleci yakalıyken de çubuğa **Ctrl basarak** ulaşır. | P0 | Yakalı modda Ctrl→çubuk→tıkla→Ctrl bırak akışı < 1 sn |
| D5 | **Yerleşim:** üst-orta (varsayılan), üst-sol/sağ, alt-orta; sürüklenebilir, profil başına hatırlanır. Çubuk **düzeni asla kaydırmaz** (oyun tuvali boyutu değişmez). | P1 | Çubuk açılıp kapanınca VD yeniden boyutlanmaz |
| D6 | **Küçük ve cam:** yükseklik 32 px (işaretçi) / 44 px (dokunmatik), köşe 10 px, 16 px ikonlar, ≥ 32×32 hedef. `bg-scrim`/`backdrop-blur` tokenları (hardcode renk yok), koyu/açık tema uyumlu. | P0 | Mevcut `uiTokenLock` testleri geçer |
| D7 | **Dokunmatik/kalem:** `coarse` işaretçide çubuk, üst kenardan **aşağı kaydırma** veya köşede 28 px'lik tutamakla açılır; hover yok. | P1 | Dokunmatik ekranda erişilebilir |
| D8 | **Erişilebilirlik:** `role="toolbar"`, `aria-label` Türkçe, odak halkası, ok tuşlarıyla gezinme, ipuçlarında kısayol; `prefers-reduced-motion`'da yalnız opaklık animasyonu (ölçek/kayma yok). Kaybolan çubuktaki odaklı düğüm odağı kaybetmez (çubuk odaktayken **kaybolmaz**). | P0 | Klavye ile açılıp tamamen kullanılabilir |
| D9 | **Geri bildirim:** düğme basışı 90 ms mikro-etkileşim; durum değişimlerinde ikon değişir (Yakala ↔ Serbest), toast yerine **çubuk içi** 1 sn'lik etiket (oyuna ikinci katman eklemez). | P1 | — |

**Taslak (üst-orta, görünür hâl):**
```
              ┌──────────────────────────────────────────────────────────┐
  (boşta:)    │ ▔▔▔▔▔  ← 2 px tutamak, %25 opak                          │
              └──────────────────────────────────────────────────────────┘
              ╭────────────────────────────────────────────────────────╮
  (yaklaşınca)│  ⌖ Yakalı · Ctrl   │ ⌨ Düzen │ ♪ │ ▦ HUD │ — │ ▢ │ ⤢ │ ⋯ │
              ╰────────────────────────────────────────────────────────╯
               imleç durumu          tuşlar   ses  HUD  küçült büyüt tam hub
```

### 4.E Tam ekran, kısayol güvenliği ve çıkış

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| E1 | **Oyun modunda askıya alınan WM kısayolları:** Ctrl+W, Ctrl+M, Ctrl+Shift+F/E/D, Win+D, Ctrl+Alt+Ok, Alt+Tab (uygulama içi), ve **Esc'in tam ekran çıkışı.** Tek karar noktası `matchWmShortcut` + `shortcutsSlice`'a *"oyun modu aktif mi"* koşulu eklenir; keyboardInject'in `isWindowManagerShortcut` kontrolü **aynı koşulu** kullanır (ikisi ayrışmaz — bugünkü sözleşme). | P0 | Ctrl basılıyken W'ye basmak pencereyi **kapatmaz**; tablo testi: oyun modunda 0 kısayol tetiklenir (kaçış akoru hariç) |
| E2 | **Tek kaçış akoru:** varsayılan **Ctrl+Alt+G** (`event.code` ile; AltGr düzenleri `wmShortcuts.js:36-40` ile aynı yöntem). Oyun menüsünü açar: *Oyun modundan çık · Tam ekrandan çık · İmleci bırak · Kısayolları göster*. Ayarlanabilir; çakışma denetimi. | P0 | Her durumdan (yakalı, tam ekran) çıkış mümkün |
| E3 | **Esc:** Esc **oyuna iletilir** (Geri/menü); tam ekrandan çıkış için **Esc basılı tut 1,2 sn** *veya* kaçış akoru. Tarayıcı Esc'i Pointer Lock'u zorla bırakır — bu durumda "yeniden yakalamak için tıkla" ipucu gösterilir. | P0 | Kısa Esc oyuna gider; uzun Esc (1,2 sn) çıkış menüsü açar |
| E4 | **Gerçek tam ekran:** oyun tam ekranı = uygulama içi tam ekran **+** işletim sistemi tam ekranı (Fullscreen API / Tauri `setFullscreen`); **Keyboard Lock** (`navigator.keyboard.lock`) ile Esc/Alt+Tab/Win benzeri tuşlar sayfaya iletilir (**doğrulanacak**, §9 S1). | P1 | Tam ekranda Alt+Tab oyuna iletilir (desteklenen WebView'larda) |
| E5 | **Görev çubuğu/panel erişimi:** tam ekranda Görev Çubuğu gizli (mevcut). Oyun menüsünden *DeX Hızlı Paneli*, *Ses*, *Bildirimler* erişilir. | P1 | — |
| E6 | **Çözünürlüğü koru:** oyun modunda büyüt/küçült/tam ekran **yalnız görsel ölçek**tir; sanal ekran çözünürlüğü/DPI **değiştirilmez** (G-12). Yeniden boyutlandırma yalnız kullanıcı "Çözünürlüğü yeniden ayarla"yı seçerse ve **uyarıyla** ("Oyun yeniden başlayabilir"). | P0 | Tam ekran geçişi `commitResize` çağırmaz (test) |
| E7 | **Boyut hazırları:** Çubukta "Sığdır / 100% / Doldur"; en-boy kilidi varsayılan açık (oyunun oranı bozulmaz). | P1 | — |

### 4.F Performans

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| F1 | **Oyun performans seti** (mod açılınca otomatik, tek tek geri alınabilir): ambiyans arka planı **kapalı**, SVG keskinleştirme **kapalı**, küçük resim yakalama 500 ms → **kapalı** (taskbar önizlemesi oyun için son bilinen kare/ikon), tuval `will-change` yalnız gerektiğinde. | P0 | Oyun modunda `toDataURL` çağrısı 0; arka plan filtresi yok; ölçülen CPU/GPU düşüşü rapor edilir |
| F2 | **Sabit akış profili:** oyun için hedef 60 fps, bitrate tabanı (`MIN_BITS_PER_PIXEL_PER_FRAME` ile uyumlu), düşük gecikmeli kodek seçimi; kullanıcıya "Kalite / Gecikme" tek kaydırıcı. 90/120 Hz için VD yenileme hızı desteği **ölçülecek** (§9 S4). | P1 | Hedef fps'te `queueMs` p95 < 100 ms (HUD tanımıyla) |
| F3 | **Bağlantı ön kontrolü:** oyun modu açılırken `isWirelessLink` ise "USB önerilir — Wi-Fi'da gecikme/kare düşüşü olabilir" tek satır; sürekli nag yok (bir kez / profil). | P1 | — |
| F4 | **Isı koruması:** `deviceThermal` eşiği aşılırsa HUD'da "Telefon ısındı — kare hızı düşebilir"; otomatik kalite düşürme **öneri**, kullanıcı onayıyla. | P1 | — |
| F5 | **Arka plan sessizliği:** oyun penceresi odakta ve görünürken telemetri/çizim işleri oyun dışı pencereler için azaltılır (mevcut `ENABLE_OCCLUSION_FREEZE` ile **çakışmadan**). | P2 | — |

### 4.G HUD (oyuncu için)

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| M1 | Oyun modunda HUD **varsayılan kapalı**; Çubuk ▸ HUD ile açılır. Açıkken **minimal satır**: `FPS · ms · Mbps` ve renkli durum noktası. Boşta opaklığı ayarlanabilir, **tıklamayı yutmaz** (varsayılan `pointer-events:none`), sürüklenebilir köşe. | P0 | Varsayılan oyun modunda ekranda HUD yok |
| M2 | **Genişletilmiş görünüm** (Çubuktan): kare süresi grafiği, **%1 low FPS**, RTT, birikme (kuyruk), atlanan kare, bitrate, giriş kuyruğu/açık parmak, telefon sıcaklığı/yükü (mevcut telemetri). Sayı uydurma yok; "—". | P1 | Mevcut `LatencyHudOverlay` ölçümleri aynen; yeni metrik gerçek ölçüme dayanır |
| M3 | **F8 kısayolu** `window`'a değil ilgili pencere belgesine (PiP dahil) bağlanır; oyun modunda kısayol tablosundan *ayarlanabilir*. | P1 | PiP'te de çalışır |
| M4 | **Uçtan uca gecikme iddia edilmez.** İleride ölçülecekse yalnızca "tıkla → ilk değişen kare" **tahmini** olarak ve açıkça "tahmin" etiketiyle (§9 S3). | — | — |

### 4.H Ses

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| H1 | Çubukta pencere ses düğmesi (`AudioButton` yeniden kullanılır): ses, sessize al, çıkış (PC/Telefon). | P0 | — |
| H2 | **Oyun sesi hiç kısılmaz:** ses odağı (`duckOthers`) açık olsa bile oyun penceresi duck'tan **muaf**; başka OpenDeX penceresi odaklanınca oyun sesi düşmez. | P1 | Test: oyun penceresi `duckFactor === 1` |
| H3 | Ses gecikmesi için ayrı hedef ve ölçüm: ses/görüntü kayması HUD'da "kayma" olarak gösterilemiyorsa dürüstçe "ölçülemiyor" (§9 S3). | P2 | — |

### 4.I Bildirimler (rahatsız etme)

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| I1 | **Oyun sırasında rahatsız etme:** oyun modu açık + pencere odakta iken Android heads-up kartları ve sistem toast'ları **bastırılır**, birikir; mod kapanınca (veya Çubuktan) *"3 bildirim kaçırdınız"* tek özet olarak gösterilir. | P1 | Oyun odaktayken ekrana kart düşmez; özet çıkışta görünür |
| I2 | **İstisna listesi:** arama/alarm/ısı uyarısı gibi kritikler (kullanıcı tanımlı) bastırılmaz. | P2 | — |
| I3 | Telefondaki gerçek DND (Android) ile **birleştirilmez**; yalnız PC arayüzü etkilenir (bildirimler telefonda kalır). | P1 | — |

### 4.J Gamepad (faz 3)

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| J1 | Gamepad API ile tak-çalıştır; sol çubuk → joystick düğümü, sağ çubuk → bakış, tetikler/tuşlar → `tap/hold` düğümleri; ölü bölge ve eğri ayarı. | P2 | Xbox/DualSense standart eşlemesiyle oyun oynanır |
| J2 | Kol bağlıyken klavye/fare profili ile **birlikte** çalışabilir (hangisi son kullanıldıysa o baskın). | P2 | — |
| J3 | Titreşim → kol titreşimi (telefon haptiği alınabilirse **araştırılacak**). | P2 | — |

### 4.K Dayanıklılık ve yaşam döngüsü

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| K1 | **Kısa kopma (0–5 sn):** mevcut kısa bağlantı kesintisi toparlama davranışıyla uyumlu; oyun modunda kopma sırasında giriş durur, **B3** tüm parmakları bırakır, geri gelince imleç durumu korunur. | P0 | Kopma sonrası takılı parmak yok |
| K2 | **Uzun kopma/uyku:** mod bayrağı ve profil korunur; yeniden bağlanınca "oyuna devam" tek satırı. Telefon ekran/kilit davranışı mevcut davranışla (pencereler açıkken telefon uyumaz — `backend/app/device/phone_awake.py`) uyumlu; oyun oturumunda ekranın uyumaması **doğrulanacak**. | P1 | — |
| K3 | **Odak kaybı (başka PC uygulaması):** `blur` → tüm parmaklar bırakılır, imleç serbest, tuş basılıları temizlenir; odak dönünce **otomatik yakalama yok** (tıkla ile). | P0 | Alt+Tab ile çıkıp dönen oyuncuda "yürümeye devam" olmaz |
| K4 | **Pencere kapatma/küçültme** sırasında yakalama bırakılır ve işaretçiler temizlenir. | P0 | — |

### 4.L Öğretme ve ilk kullanım

| ID | Gereksinim | Ö | Kabul |
|---|---|---|---|
| L1 | **İlk açılış turu** (tek seferlik, atlanabilir, 3 adım): "İmleç oyunu izler → bırakmak için **Ctrl** → çubuk belirir"; "Tuş düzenini kur"; "Çıkış: **Ctrl+Alt+G**". Anlatım *gerçek davranışla* (örnek animasyon yerine canlı ipucu). | P1 | Turu bitiren kullanıcı üç jesti yapabilir (kullanılabilirlik testi, §7) |
| L2 | **Bağlamsal ipuçları:** ilk Ctrl'de "Ctrl: imleci bırak", ilk yakalamada "Yakalamak için tıkla"; her biri en fazla 2 kez. | P1 | — |
| L3 | **Kısayol kartı:** oyun menüsünde tüm oyun modu tuşları tek ekranda; yazdırılabilir değil, aranabilir. | P2 | — |

---

## 5. Hub ve "Kontroller" kararı

Hub (`HubPanel.jsx`) bugün: *Görüntü* (ölçek, Dinamik DP, Kontroller) · *Pencere* (tam ekran, PiP, üstte tut, oran, başlık) · *Workspace'e gönder*.

| Değişiklik | Gerekçe |
|---|---|
| "Kontroller" → **"Yön tuşları"** olarak yeniden adlandır; ikon `Gamepad2` → yön tuşu ikonu. Hata G-0 düzeltilsin (kind='dpad' için ya `keycode` olarak `arrowup…` ya da arka uçta `dpad` desteği). | İkon/işlev uyumsuzluğu; çalışmayan oklar |
| Yeni **"Oyun"** bölümü: `Oyun modu` (anahtar) · `İmleç: Yakalı/Serbest` · `Tuş düzeni…` · `Profil: <ad>` · `Oyun Çubuğu ayarları…` | Tüm oyun akışları tek yerden bulunur |
| Başlık çubuğunun hub düğmesi (`Settings2`) oyun modunda Oyun Çubuğu'na taşınır (⋯) | Çubuk başlığın yerine geçer |
| `Dinamik DP` karosu oyun modunda *kilitli* görünür ("Oyun için sabit") | E6 ile tutarlı |

Hub paneli panel geometrisini (`absolute right-2 top-12`) korur; oyun modunda panel Çubuğun altına hizalanır ve **oyun üstünde sürekli açık kalmaz** (dışarı tık/Ctrl bırak → kapanır).

---

## 6. Frontend UX/UI şartnamesi (kalite çıtası)

Bu bölüm, "frontend UI/UX en üst kalitede olmalı" gereksiniminin ölçülebilir karşılığıdır.

- **Tasarım sistemi:** yalnız mevcut tokenlar (`bg-frame`, `bg-scrim`, `text-scrim-foreground`, `ring-ring`, `status-*`); hardcode renk yok; `uiTokenLock` testi geçer. Koyu/açık tema.
- **Hareket:** süreler 90 / 120 / 200 ms (basış / belirme / kaybolma); eğri `[0.22, 1, 0.36, 1]` (Hub ile aynı). `prefers-reduced-motion`: yalnız opaklık.
- **Katman (z-index):** Oyun Çubuğu pencere çerçevesinin *içinde* yaşar (Hub paneli gibi); yerel katman ölçeğinde Hub'ın altında, Keymapper kaplamasının üstünde. Global `Z_INDEX` tablosuna girdi eklenmez (`zIndex.js` notu: pencere içi küçük katmanlar yerel ölçekte kalır).
- **Metin:** Türkçe, kısa, eylem odaklı ("Yakalamak için tıkla", "Bırakmak için Ctrl"). Emoji yok; ikon `lucide-react`.
- **Boş/hata/yükleniyor durumları:** her ekran için tanımlı (profil yok → şablon öner; yakalama reddedildi → neden + ne yapılır; bağlantı koptu → "Oyun duraklatıldı, geri bağlanıyor").
- **Duyarlılık:** 380 px altı (`compact`) için Hub 2 sütun (mevcut); Çubuk dar pencerede ikincil düğmeleri `⋯` altına katlar.
- **Erişilebilirlik:** klavye ile tam kullanım, `aria-live` ile durum duyurusu (yakalandı/serbest), odak yönetimi, kontrast ≥ 4.5:1 görünür hâlde.
- **Görsel doğrulama:** her yeni bileşen için Chromium ekran görüntüsü harness'ı (Medya Merkezi'nde kullanılan yöntem) — açık/koyu, çubuk görünür/gizli, yakalı/serbest.
- **Piksel disiplini:** çubuk hedefleri ≥ 32 px; bitişik hedefler arası ≥ 4 px; ikonlar 16 px (24 px kutuda).

---

## 7. Test ve doğrulama stratejisi

| Katman | Ne | Not |
|---|---|---|
| Birim (vitest) | `keymapperEngine` (joystick kimlikleri, `code` eşleme, çakışma), kaçış akoru/WM tablosu (oyun modunda 0 kısayol), imleç durum makinesi, Ctrl-bırakma, `getCoalescedEvents` birleştirme | Mevcut `keyboardInject.test.js` kalıbı |
| Bileşen (Testing Library) | Oyun Çubuğu (yaklaşma → belirme → zaman aşımı → kaybolma; odaktayken kaybolmama; `pointer-events`), Hub "Oyun" bölümü, düzenleyici (ekle/taşı/geri al/kaydet-vazgeç) | Zamanlayıcı için sahte saat |
| Backend (pytest) | `/ws/input` çoklu `id` → doğru `pointerId`; kopmada tüm açık parmaklara UP (G-7); `dpad` hatası (G-0); geriye uyum (id yok) | `FakeControl` ile baytları doğrula |
| Sözleşme | Ön yüz mesaj şeması ↔ backend (`apiContract.test.js` genişler) | G-0 sınıfı hatayı yakalar |
| Cihaz | Çoklu dokunuş gerçekten çalışıyor mu (S2), 10 parmak üst sınırı, bakış yeniden merkezleme | Elle + kayıtlı script |
| WebView | Pointer Lock / Keyboard Lock / Esc davranışı: **WebView2 (Win)**, WKWebView (macOS), WebKitGTK (Linux) | §9 S1 — destek matrisi |
| Kullanılabilirlik | 5 oyuncuyla: "imleci bırak → çubuğu kullan → geri yakala → çık" görevleri | Başarı ≥ 4/5, ilk denemede |
| Performans | F1 öncesi/sonrası CPU/GPU, kare süresi, `queueMs` | Sayı **ölçülerek** raporlanır |

**Test hacmi hedefi:** üretim kodunun ≈ 1/3'ü (projedeki yerleşik oran); gerçek oran raporda dürüstçe verilir.

---

## 8. Riskler

| Risk | Olasılık | Etki | Azaltma |
|---|---|---|---|
| **Pointer/Keyboard Lock'un Tauri WebView'larında eksik/farklı davranışı** (özellikle WKWebView, WebKitGTK) | Yüksek | Yüksek | S1 spike; Tauri `setCursorGrab` yedeği (A8); destek matrisini ürün içinde açıkça göster |
| **Esc'in Pointer Lock'u zorla bırakması** (tarayıcı kuralı, engellenemez) | Kesin | Orta | E3: kısa Esc oyuna + "tıkla ile yeniden yakala"; Keyboard Lock ile hafifletme (S1) |
| **Yakalamayı Ctrl bırakınca otomatik geri almak** kullanıcı etkinleşmesi ister (keyup etkinleşme saymaz) | Yüksek | Düşük | Tasarım gereği "bir sonraki tıklama yakalar" (A3) — bilinçli UX |
| **Anti-hile / ToS:** enjekte edilmiş giriş (`INJECT_EVENTS`) ve sanal ekran bazı oyunlarda tespit/engel (hesap yaptırımı riski) | Orta | Yüksek | Hile benzeri özellik yok (C8); ilk açılışta kısa uyarı; **hangi oyunun çalıştığı iddia edilmez**, uyumluluk listesi ölçülerek yayımlanır |
| **Çoklu dokunuşun sunucu tarafı sınırı** (scrcpy `PointersState` ≈ 10) ve yama gereksinimi | Orta | Yüksek | S2 spike; gerekirse mevcut yama zincirine (`backend/scrcpy/patches`) 4. yama |
| **Ağda gecikme** (Wi-Fi) oyunu kullanılmaz kılar | Yüksek | Yüksek | F3 ön kontrol; HUD'da dürüst durum; USB önerisi |
| **Sanal ekranda oyun açılmaması / yön değişince yeniden başlaması** (yoğunluk/yönelim) | Orta | Yüksek | E6 çözünürlüğü kilitleme; yönelim için C6; `DensityReconciler` ile entegrasyon testi |
| **Fare 1000 Hz → WS taşması** | Orta | Orta | B4 koalesans, B8 geri basınç, delta birikimi |
| **Kapsam şişmesi** (her oyun için özel istek) | Yüksek | Orta | İlke 6: oyun adına kod yok, yalnız veri/profil |

---

## 9. Spike'lar (uygulamadan önce, kısa ve ölçülü)

Her spike **1–2 gün**, çıktısı bir "evet/hayır + ölçüm" notudur. Sonuç gereksinimleri değiştirebilir.

| S | Soru | Sonuca göre |
|---|---|---|
| **S1** | Pointer Lock (`unadjustedMovement`), Keyboard Lock ve Esc davranışı **WebView2 / WKWebView / WebKitGTK**'te nasıl? Tauri `setCursorGrab/Visible` yedeği çalışıyor mu? | A2, A8, E3, E4 kapsamı ve platform destek matrisi |
| **S2** | scrcpy sunucusu **farklı `pointerId`** ile gerçek çoklu dokunuşu sanal ekranda (`displayId`) uyguluyor mu? Üst sınır kaç? | B1; gerekirse 4. yama |
| **S3** | HUD'a dürüstçe konabilecek bir **giriş→kare gecikmesi tahmini** var mı (ör. dokunuş sonrası ilk farklı kare)? | M4, H3 |
| **S4** | VD için 90/120 Hz ve oyun uyumlu **sabit yenileme** mümkün mü? Kodek/bitrate profili? | F2 |
| **S5** | Daemon, uygulamanın oyun olduğunu (`CATEGORY_GAME`) güvenilir raporlayabiliyor mu? | §3 giriş önerisi |
| **S6** | Bakış yeniden merkezleme (bırak-bas) oyunlarda kamera zıplaması yapıyor mu? En iyi yeniden merkezleme eşiği? | A5 parametreleri |

---

## 10. Açık ürün kararları (sizden)

1. **Bırakma tuşu:** Ctrl varsayılan (isteğiniz). Birçok FPS düzeninde *Ctrl = çömel* olabildiği için tuşun **ayarlanabilir** olmasını ve çakışma uyarısını öneriyorum (A3). Onaylıyor musunuz?
2. **Oyun modunda Esc:** "kısa Esc oyuna, uzun Esc çıkış" (E3) — oyuncular için doğru buldum; alternatif: Esc hep çıkış (güvenli ama oyunu bozar). Hangisi?
3. **Çubuk bekleme opaklığı varsayılanı:** %0 (görünmez + ince tutamak) mı, %25 mi? Ben %0 + tutamak öneriyorum.
4. **Kapsam:** F1 yalnız **klavye+fare**; **gamepad (F3)** sonraya. Uygun mu?
5. **Hız–kalite:** oyun profilinde fps/gecikme, kalitenin önünde mi? (Önerim: evet, tek kaydırıcı, varsayılan "Dengeli").

---

## 11. Fazlama

Efor kabaca: **S** ≤ 2 gün · **M** ≈ 1 hafta · **L** ≈ 2+ hafta (tek geliştirici, test dâhil). Bağımlılıklar oklarla.

| Faz | İçerik | Efor | Çıktı |
|---|---|---|---|
| **F0 — Bugünkü hatalar** ✅ *tamamlandı* (oyun modundan bağımsız) | G-0 (D-pad), G-3 (düzenleyiciye giriş), G-7 (soket kopunca UP), G-14'ün F8/PiP doğrulaması, "Kontroller" yeniden adlandırma | S | Güvenilir temel, regresyon testleri |
| **F1a — Spike'lar** | S1, S2, S6 (S3–S5 paralel) | S–M | Karar notları; kapsam netleşir |
| **F1b — Çekirdek (MVP)** | B1–B4, B6, A1–A6, A8, C1–C4, D1–D4, D6, D8, E1–E3, E6, F1, M1, K1/K3/K4 | **L** | Oynanabilir klavye+fare deneyimi |
| **F2 — Cila** | B5, B7–B8, C5–C6, D5, D7, D9, E4–E5, E7, F2–F4, M2–M3, H1–H2, I1, K2, L1–L2 | **L** | "Tam ve zengin" deneyim |
| **F3 — Genişleme** | J1–J3, A7, C2 (swipe), C7, I2, L3, F5 | M–L | Gamepad, şablonlar, nişangâh |

### 11.1 F0 — yapılanlar ve sınırları

| Madde | Ne değişti | Kanıt (test) |
|---|---|---|
| **G-0** Yön tuşları | Oklar `kind:'dpad'` yerine telefonun kabul ettiği `keycode` yoluyla (`arrowup…`, Seç = `enter`) gider; reddedilen basış artık **loglanır**, yutulmaz. "Kontroller" → **"Yön tuşları"** (ikon `Move`; gamepad ikonu yanıltıcıydı). | `windowHubInput.test.jsx` (UI → HTTP gövdesi), `keyboardInject.test.js` |
| **Sözleşme** | Rota var mı sorusuna ek olarak **değer** sözleşmesi: backend `kind` listesi, `keycode` adları ve `/ws/input` mesaj tipleri `backend-input-contract.json` ile pinlenir; arayüzde yazılı her değer buna karşı taranır. Aynı sınıf hata artık CI'da kırmızı. | `inputContract.test.js`, `test_route_manifest.py` |
| **G-7** Takılı parmak | Backend: bağlantı başına `TouchTracker`; soket kapanınca veya `release_all` gelince basılı parmak **son noktasında kaldırılır** (yeniden kurulan pencerenin yeni kontrolüne sahte UP gitmez). Ön yüz: pencere `blur`, sekme gizlenmesi, odağın başka pencereye geçmesi, donma/simge durumu, tuş editörü ve kapanışta **her şey bırakılır**; keymapper'ın "W basılı" belleği de silinir (yoksa dönüşte joystick yönlendirilemezdi). Odak dönüşünde, zaten bırakılmış bir tuşun `keyup`'ı başka bir parmağı kaldırmaz. | `test_ws_input.py`, `test_touch_control.py`, `videoCanvasInput.test.jsx`, `keymapperEngine.test.js` |
| **G-3** Tuş düzenleyicisi | Hub'a **"Tuş düzeni"** satırı (tanımlı tuş sayısını da söyler) → düzenleyiciyi açar, Hub'ı kapatır. Yalnız düzenleyicisi olan pencerelerde görünür (Workspace / DeX kırpma / Dosyalar'da yok). **Esc** ile çıkılır (değişiklikler zaten anında kaydedilir; açık tuş seçici varsa önce o kapanır). Düzenleyici açıkken basılan tuşlar artık telefona **yazılmıyor**. | `windowHubInput.test.jsx`, `keymapperOverlay.test.jsx` |
| **G-14** HUD F8 | Dinleyici, HUD'ın çizildiği **belgenin penceresine** bağlandı (PiP'te çalışır, ana pencere F8'i PiP'tekini etkilemez). | `latencyHudShortcut.test.jsx` |

**F0'ın bilinçli sınırları (F1'e bırakıldı):** hâlâ **tek sanal parmak** var (G-1): tuş düzenleyicisi artık açılıyor, ancak joystick + ateş
aynı anda çalışmaz; kamera/fare bakışı, fare tuşları ve profil yönetimi yok. Yani düzenleyici **erişilebilir ama oyun için henüz yeterli
değil** — oyun için asıl iş F1b'dir. G-17 (Home tuşu) incelenmeden değiştirilmedi.

**Çıkış kriteri (F1b → F2):** §12'deki P0 kabul ölçütlerinin tamamı + kullanılabilirlik testi 4/5.

---

## 12. Başarı ölçütleri

| Metrik | Hedef | Nasıl ölçülür |
|---|---|---|
| Takılı parmak (kopma/odak kaybı sonrası) | **0** | B3 otomatik testi + cihazda elle |
| Eşzamanlı işaretçi | ≥ 3 (joystick + bakış + ateş) | S2 / cihaz testi |
| İstemsiz pencere kapanması/çıkışı (oyun modunda) | **0** | E1 tablo testi + kullanılabilirlik |
| Ctrl → imleç serbest → çubuk görünür | < 100 ms | Elle + zaman damgalı kayıt |
| İmleç yakalı iken pencereden çıkma | **0** (5 dk) | S1/elle |
| Çubuk boştayken oyuna etkisi | 0 piksel örtü (tutamak hariç), 0 yutulan tıklama | D3 testi |
| `queueMs` p95 (hedef fps'te) | < 100 ms | Mevcut HUD ölçümü |
| Oyun modunda boşa arka plan işi | `toDataURL` = 0, filtre = yok | Kod testi + profil |
| Düzenleyiciyi bulma | ≤ 2 tık, ≥ 4/5 ilk denemede | Kullanılabilirlik |

---

## 13. Kapsam dışı (bu belgede bilinçli olarak yok)

- Telefondaki oyunu **başlatma/kurma** akışı (mevcut uygulama başlatıcıyı kullanır).
- Oyun kaydı / yayın (OBS entegrasyonu), ekran görüntüsü galerisi.
- Çevrimiçi profil paylaşımı (yalnız dosya dışa/içe aktarma).
- Hile benzeri otomasyon (otomatik ateş, makro, geri tepme telafisi).
- Belirli bir oyun için özel kod yolları (yalnız veri).

---

### Ek A — Mevcut yapı taşları (yeniden kullanım haritası)

| İhtiyaç | Mevcut parça | Yapılacak |
|---|---|---|
| Pencere eylemleri | `useOsWindowController` (küçült/büyüt/kapat/PiP) | Çubuk aynı denetleyiciyi çağırır |
| Başlık gizleme kararı | `windowModel.isHeaderHidden` | `gameMode` ise Oyun Çubuğu'nu seçer |
| WM kısayol kararı | `wmShortcuts.matchWmShortcut` + `shortcutsSlice` | `gameMode` koşulu (tek yer) |
| Esc yığını | `lib/escapeStack` | Oyun menüsü yığına girer |
| Giriş taşıyıcı | `WindowTouchSocket` / `/ws/input` | `id`, `key` (WS tuş), `releaseAll` mesajları |
| Dokunma kablosu | `touch_control.serialize_touch` | `pointerId` parametreli |
| Eşleme motoru/arayüz | `keymapperEngine`, `KeymapperOverlay`, `keymapStore` | Genişlet; girişi aç |
| Ses | `AudioButton`, `appAudioMixer` | Duck muafiyeti |
| Telemetri | `LatencyHudOverlay`, `streamStats`, `deviceThermal`, `isWirelessLink` | Oyun HUD'ı bunları okur |
| Yoğunluk/çözünürlük | `DensityReconciler`, `commitResize` | Oyun modunda kilitle (E6) |

### Ek B — Önerilen veri şekli (taslak, bağlayıcı değil)

```jsonc
// Oyun Profili (paket başına çoklu; arka uçta saklanır)
{
  "id": "prof_fps", "package": "com.example.game", "name": "FPS", "version": 1,
  "release_key": { "code": "ControlLeft" },
  "mouse": { "sens_x": 1.0, "sens_y": 1.0, "invert_y": false, "ads_mult": 0.6, "raw": true },
  "layouts": {
    "landscape": { "nodes": [
      { "id": "n1", "type": "joystick", "keys": {"up":"KeyW","left":"KeyA","down":"KeyS","right":"KeyD"}, "rx": .18, "ry": .72, "radius": .10, "pointer": 1 },
      { "id": "n2", "type": "look",     "rx": .60, "ry": .10, "rw": .38, "rh": .80, "pointer": 2 },
      { "id": "n3", "type": "hold",     "trigger": {"mouse":"left"},  "rx": .86, "ry": .66, "pointer": 3 },
      { "id": "n4", "type": "toggle",   "trigger": {"mouse":"right"}, "rx": .78, "ry": .48, "pointer": 4 }
    ]},
    "portrait": { "nodes": [] }
  },
  "bar": { "idle_opacity": 0.0, "dock": "top-center" },
  "perf": { "ambient": false, "sharpen": false, "thumbnails": false, "hud": false },
  "lock_resolution": true
}
```

```jsonc
// /ws/input mesajları (geriye uyumlu: id yoksa bugünkü davranış)
{ "type": "down", "id": 1, "x": 540, "y": 1700 }
{ "type": "move", "id": 1, "x": 600, "y": 1650 }
{ "type": "up",   "id": 1, "x": 600, "y": 1650 }
{ "type": "key",  "code": "ShiftLeft", "down": true }       // WS tuş yolu (B5)
{ "type": "release_all" }                                   // takılı parmak güvenliği (B3)
```
