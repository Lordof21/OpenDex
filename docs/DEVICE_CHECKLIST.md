> **Language note:** this checklist is written in Turkish (translation is on the [roadmap](ROADMAP.md)). Each item says *what to do → what you should see → which log line or place to look at if you do not*; the log lines are the backend's real ones.
> Used by maintainers for the checks that only a real phone can answer — see [TESTING.md](TESTING.md#the-real-phone-checklist).

# Cihazda doğrulama kontrol listesi

Bu bölümlerin kodu ve testleri hazır; ama **gerçek bir telefonda henüz denenmedi** (geliştirme ortamında telefon yok).
Her madde: ne yapılır → ne görülmeli → görülmezse hangi günlük satırı / nereye bakılır.

## 1. DPI — telefona aktarırken boyut telefondakiyle aynı
- Telefonda Ayarlar → Ekran → "Ekran boyutu" / geliştirici "En küçük genişlik" değerini bir kez değiştir (ör. 375 → 380 dp).
- Bağlıyken Chrome'u bir VD penceresinde aç, sonra telefona aktar.
- **Beklenen:** telefondaki Chrome, aktarımdan önceki telefon Chrome'uyla aynı boyutta. Günlükte `phone metrics: … @ 513 dpi`.
- Olmazsa: `[android_shell] telefonun yoğunluğu okunamadı` (daemon'un `display_get` cevabı gelmemiş), `adb shell wm density`.

### 1b. DeX boyutlu VD penceresi → telefon (boyut + DPI birlikte oturur)
- Bir VD penceresini geniş/yatay (ör. 1280×720 ya da tam ekran) yapıp Chrome/YouTube aç, **telefona aktar**; sonra **PC'ye geri al**.
- **Beklenen:** «Görünüm Optimize Ediliyor» perdesi sırasında sanal ekran telefonun kendi boyutuna (ör. 1080×2400) ve
  yoğunluğuna çekilir; telefonda ilk karede **telefon düzeni** görünür (tablet/yatay düzen ya da letterbox yok). Geri alınca pencere
  eski boyutunda ve yoğunluğunda döner.
- Günlük sırası: `[HANDOFF] Parametreler: … pencere=1280x720 @ 200 DPI → telefon=1080x2400 @ 520 DPI`,
  `[HANDOFF: ÖN-İNİŞ] sanal ekran 1280x720 @ 200 → 1080x2400 @ 520 DPI`, `move-stack`; geri alırken
  `[HANDOFF: GERİ ALMA] sanal ekran pencere geometrisine döndü: 1280x720 @ 200 DPI` (görev taşınmadan ÖNCE).
- Boyut okunamıyorsa/yerinde boyutlandırma yapılamıyorsa yalnız DPI ön-inişi çalışır (eski davranış): `[HANDOFF] … boyut okunamadı`.
- Aktarım bu yüzden ~1–2 sn uzayabilir (ekran yeniden boyutlanır, encoder yeniden başlar) — perde bu sürede PC'de.

## 2. Workspace → telefon → geri
- Workspace'te bir uygulama aç (serbest pencere), telefona aktar, geri getir.
- **Beklenen:** uygulama tam ekran değil, pencere kutusunda geri döner.
- Günlükte `[TRANSFER] … target=freeform … verdict=ok method=daemon`. `verdict=bad` ise `phase=after` satırındaki mode/bounds.

### 2b. VD penceresi → telefon (serbest pencere) → geri al
- Hızlı DeX ayarlarında "Telefona aktar" kipini **Serbest pencere** yap. Bağımsız (VD) bir pencereyi telefona aktar, telefonda
  serbest pencere olarak açıldığını gör, sonra "PC'ye geri al" de.
- **Beklenen:** uygulama VD penceresinde **tam ekran** döner (akışın içinde küçük çerçeve değil). Yoğunluğa dokunulmaz.
- Günlükte `[TRANSFER] … target=fullscreen … display=<VD> … verdict=ok method=daemon` (zaten tam ekransa `attempts=0`).
- Aynısı: uygulama zaten telefondayken PC'deki uygulama simgesinden açmak (görev ışınlama) ve kilit açıldıktan sonra.

## 3. İlk açılış
- Uygulamayı aç; açılış ekranında "Sağlık kontrolü 1/3 → Sağlıklı · x ms" görülmeli.
- Günlükte `[STARTUP] cihaz=bound(usb|wireless) daemon=healthy 1/3 servisler=ready`.
- Telefon Yükü paneli: açılıştaki "diğer kabuk komutu" sayıları eskisinden çok düşük; Wi‑Fi'da video takılmamalı.
- Daemon yanıt vermezse: "ADB ile devam ediliyor" uyarısı çıkar, oturum yine açılır.

## 4. Anahtar kare (scrcpy yaması 0004)
- Pencere açılırken günlükte `OpenDex sunucusu: …, keyframe_request, …` olmalı.
- Yeni bir PiP penceresi aç / Wi‑Fi'ı birkaç sn kes-bağla: `[Keyframe:REQ 🔑] … kodlayıcı durmadan keyframe isteniyor`;
  görüntü takılmadan gelir.
- `[Keyframe:FALLBACK]` görürsen o telefonun encoder'ı isteği yok sayıyor demektir; eski yola (RESET_VIDEO) düşer, bozulmaz.
- Telefon Yükü / bant genişliği: durgun ekranda 10 sn'de bir görülen sıçramalar dakikada bire inmeli.
- İkiliyi kendi makinende yeniden üretmek istersen: `python backend/scrcpy/build.py` (Android SDK gerekir).

### 4b. Bildirime tıklayınca WhatsApp açılıp siyah ekran
- WhatsApp'tan bildirim gelince PC'de bildirime tıkla (pencere kapalıyken, açıkken ve simge durumundayken ayrı ayrı dene).
- **Beklenen:** sohbet 1–2 sn içinde görünür, siyah kalmaz. Siyah kalırsa günlükte şunlara bak:
  - `[Keyframe:REQ 🔑] … client still waiting for a keyframe` tekrar tekrar geliyorsa istemci anahtar kare bekliyor (istek düşüyor):
    `[Keyframe:FALLBACK]` da var mı, `[Resize:…]` bekleyen bir boyutlandırma var mı?
  - `[TRANSFER] … phase=landed … was=freeform` varsa görev VD'ye serbest kipte inmiş ve tam ekrana alınmış.
  - `KİLİT` / `app_lock_*` satırları: HyperOS uygulama kilidi araya giriyor mu?
- Siyah ekran **her** sohbette değil de yalnız **kilitli sohbetlerde** ya da WhatsApp "Ekran kilidi" açıkken oluyorsa neden
  yazılım değil: WhatsApp bu ekranları FLAG_SECURE ile çiziyor ve sanal ekran yakalaması bunları siyah gösterir.

## 5. Çözünürlük kipi geçişi
- Bir pencerede Dinamik‑Fix → Dinamik → 1080p arasında geçiş yap; her geçişte pencere yeniden boyutlandırılmalı
  (`[OpenDeX Resize:REQ 📐]`). Sayfayı yenileyip tekrar dene: yine çalışmalı.

## 6. Bağlantı dayanıklılığı
- USB kablosunu 1–2 sn çıkarıp tak: pencereler kapanmamalı, donup geri gelmeli; görev çubuğunda cihaz adı kalmalı.
- Bağlanma sırasında hata (ör. telefonda USB hata ayıklama onayını reddet): "Telefona bağlanılamadı — yeniden deneniyor…"
  bildirimi; onay verilince kendiliğinden bağlanmalı. Günlükte `[BIND] … bağlanamadı`.
- USB → Wi‑Fi geçişi sırasında Wi‑Fi'ı kapat: USB hâlâ takılıysa oturum USB'de sürmeli (`[SWITCH] oturum … üzerinde sürüyor`).

## 7. Workspace: pencere küçülünce yazılar, yukarı kaydırınca küçülen görev
- **Yazı boyutu:** Workspace penceresini küçült (ya da büyüt), 1 sn bekle. Otomatik DPI'daki görevlerin yazısı VD pencerelerindeki gibi
  okunur kalmalı (pencere küçülünce DPI yükselir, uygulama telefon düzenine geçebilir). Günlükte `[ECO WORKSPACE:DENSITY] … Yeni DPI`.
  Elle DPI seçilen görev değişmez.
- **Küçülen görev:** Workspace'te bir görevde yukarı kaydır (ya da uzun süre kullanma) ve görev küçülürse/kaybolursa ona **tekrar bas**:
  görev ~1 sn içinde yerine dönmeli. Günlükte `[WS-GUARD] … Workspace'te bozulmuş: <neden> — mod=… bounds=… görünür=…` ve
  `[WS-GUARD] … geri yerleştirildi`. **Bozulmayı hiç yakalamıyorsa** (görev küçülüyor ama `[WS-GUARD]` yok) bu satırı gönder:
  `[TRANSFER] … phase=after … decor=… oem=…` ve `dumpsys activity activities <görev>` çıktısı — küçülme mod/kutu/görünürlük
  dışında bir şeyse (yüzen top ayrı bir yüzey ise) yeni bir sinyal gerekir.
- **Telefonda serbest pencere tutamacı:** «Serbest pencere» kipiyle aktarınca `[TRANSFER] … phase=after … decor=[…] oem=[…]` satırı
  telefonun pencere için bir başlık/tutamaç katmanı çizip çizmediğini gösterir: `decor=yok` → tutamacı çizen telefonun kendi arayüzü
  çizmiyor (OpenDeX'in yapabileceği bir şey yok; PC'den yerleştirme düğmeleri ayrı bir özellik olur); `decor=[caption…]` ama
  taşınamıyorsa dokunma tarafında bir sorun var.


## 8. Kopmada kapatma / yeniden açma, «Uygulamayı yeniden başlat», ekran kilidi, kipler arası geçiş
Bu bölümün PC tarafı (kapatma, eşitleme, kipler) Chromium + testlerle doğrulandı; **telefona dokunan kısımlar** (yeniden başlatma,
yerinde yeniden kurma, soğuk başlatma) yalnızca gerçek cihazda doğrulanabilir.

- **Kopmada ✕:** bir VD penceresi ve bir Workspace görevi açıkken kabloyu çek (ya da Wi‑Fi'ı kapat), 2–3 sn sonra ✕'e bas.
  **Beklenen:** pencere hemen gider. Sayfayı yenile (F5) — pencere **geri gelmemeli**. Kabloyu tak: kapatma arka planda tamamlanır
  (`[WindowManager:CLOSED ✅]`), 10 sn içinde tamamlanamazsa `Pencere kapatma isteği arka uca ulaşmadı` bildirimi çıkar ve istek
  1/2/4/8/15 sn aralıklarla yeniden denenir. Günlükte `[LINK] yerinde yeniden kurma … sn içinde bitmedi` görürsen heal bir
  pencerede takılmış demektir (60 sn sonra bırakılır, kilit serbest kalır).
- **Aynı uygulamayı yeniden aç:** ✕'ten hemen sonra aynı uygulamayı aç. Yeni pencere açılmalı (eski, donuk oturumu yeniden
  kullanmamalı); günlükte `frozen window for … could not be woken; dropping it to open fresh` görürsen eski oturum atılıp sıfırdan
  açılmıştır — beklenen davranış.
- **Hub › «Uygulamayı yeniden başlat»:** takılan / siyah kalan bir uygulamada bas. Günlükte `[DENSITY] SONUÇ … manual → …`:
  `restarted` (süreç yeniden doğdu — Android 12+ ve daemon gerekir), `relaunched` (**yedek**: onDestroy→onCreate yerinde),
  uygulama hiç çalışmıyorsa `[RESTART] … soğuk başlatma` ve bildirim «başlatıldı». HyperOS'ta `am update-appinfo` etkinlikleri
  yeniden kurmuyorsa (öğrenilmişse) yedek de kanıtlanamaz: bildirim «yeniden başlatılamadı» der, pencereyi kapatıp açmak gerekir.
- **Hub › Ekran kilidi:** kilitliyken pencereyi serbestçe büyüt/küçült: görüntü (px + DPI) değişmez, sığdırılır; `[OpenDeX Resize:REQ]`
  satırı **çıkmamalı**. Kilidi aç: pencere boyutuna göre yeniden boyutlanır.
- **Kaplama / tam ekran / orta boy:** başlıktaki «Ekranı kapla» ile Hub'daki «Tam ekran» arasında art arda geç, ortadaki boya dön.
  Pencere görev çubuğunun altına **sarkmamalı**; her geçişte tek bir kutu (kaplı ⟂ tam ekran) olmalı. Görev çubuğunun altına
  sarkma bu ortamda hiçbir ekran boyutunda yeniden üretilemedi; cihazda görürsen ekran boyutunu (ölçek %) ve Windows görev çubuğunun
  otomatik gizleme durumunu bildir.


## 9. Wi-Fi «Bağlantıyı kes», Medya Merkezi'nden DeX'e aktarma, Telefon / DeX / İkisi
PC tarafı (arayüz, durum makineleri, backend mantığı) testlerle doğrulandı; **telefona dokunan** kısımlar yalnızca cihazda doğrulanabilir.

- **Wi-Fi › Bağlantıyı kes (USB ile bağlıyken) — telefon yardımcısı (jar) YENİDEN DERLENMELİ:** `py backend/java/build.py`, sonra
  OpenDeX'i yeniden başlat. Kök neden (Android Wi-Fi modülü kaynağından): `WifiManager.disconnect()` bağı yalnızca düşürür; telefon
  "bağlı değil" durumuna girince otomatik katılım hemen tarama yapıp **aynı kayıtlı ağa** birkaç sn sonra yeniden katılır — düğme
  "bozuk" görünüyordu. Yeni sürüm ağı `disableNetwork(netId)` ile kapatır (çerçeve bağı kendisi keser, otomatik katılım o ağı artık
  seçmez); aynı ağa tekrar bağlanmak (Kayıtlı ağlar › Bağlan, ya da telefonun Wi-Fi ayarları) ağı yeniden açar. **Beklenen:**
  «Kesiliyor…» → «Bir ağa bağlı değil» (telefonda başka kayıtlı bir ağ varsa ona katılabilir) ve 10 sn sonra **geri bağlanmaz**.
  Bildirim metinleri: «…otomatik katılım geri bağladı — telefon yardımcısı güncel değil» = eski jar çalışıyor (yeniden derle);
  «…otomatik katılım geri bağladı. Kalıcı olarak ayrılmak için ağı unutun…» = yeni jar ama telefon `disableNetwork`'u reddetti (HyperOS);
  «…reddetti» = `disconnect()` da reddedildi. Hangisi çıkarsa bildir.
- **Wi-Fi üzerinden bağlıyken** (adb `ip:port`): «Bağlantıyı kes» ve «Bu ağı unut» **kapalı** olmalı, altında «OpenDeX bu Wi-Fi üzerinden
  bağlı…» yazmalı. Telefonun **hotspot'una** bağlıyken (ör. 192.168.43.1) açık olmalı.
- **Medya Merkezi › «Telefon» rozeti (penceresi olmayan uygulama):** Spotify/YouTube Music'i telefonda çal, DeX'te penceresini açma.
  Medya Merkezi'nde rozete **bas** → **«DeX»** olmalı, ses telefondan **kesilip** DeX'ten gelmeli (mikserde «DeX'teki uygulamalar»da satırı
  çıkar). Tekrar bas → ses telefona döner. Rozete **basılı tut** (ya da sağ tık): altında **Telefon / DeX / İkisi** menüsü açılır;
  «İkisi» seçilince uygulama telefonda da çalmayı sürdürür, ikisi aynı anda duyulur. Kontrol et: (1) o uygulamanın medya oturumu
  kapanınca (uygulamayı kapat) ~20 sn sonra aktarım kendiliğinden biter ve uygulama telefonda sessiz **kalmaz**; (2) uygulamanın
  penceresini DeX'te açınca ses **kesilmeden** pencerenin kanalına geçer, pencereyi kapatınca DeX'te kalır; (3) yakalamayı yasaklayan
  bir uygulamada (bazı DRM/akış uygulamaları) DeX'te sessizlik olursa rozeti telefona geri al ve hangi uygulama olduğunu bildir —
  telefon ses yakalamaya izin vermiyordur; (4) basılı tutarken rozetin kısa-tık davranışı (Telefon ⇄ DeX) **tetiklenmemeli**.
- **Bilgisayar ses çıkış cihazı seçimi KALDIRILDI** (tarayıcı/WebView2 `setSinkId`, «Ses çıkış cihazı» kartı): ses, Windows'un
  varsayılan çıkışından çalar; çıkışı Windows ses ayarlarından değiştirin. Telefonun hangi cihazdan (hoparlör/Bluetooth) çalacağına
  Android karar verir; Bluetooth cihazları Hızlı Ayarlar › Bluetooth sayfasından yönetilir.
- **«İkisi» (Telefon + DeX) senkronu — telefon yardımcısı (jar) YENİDEN DERLENMELİ:** `py backend/java/build.py`, OpenDeX'i yeniden
  başlat. Tasarım: iki çıkış **ortak bir zaman çizgisine** oturur. Telefon, yakaladığı her parçayı kendi saatiyle damgalar (PTS);
  yardımcı o parçayı `PTS + hedef` anında **hoparlörden çıkacak** şekilde çalar (AudioTrack zaman damgasıyla ölçerek, tahminle
  değil); DeX sayfası da telefonun saatini birkaç hızlı turla ölçüp (en kısa gidiş-dönüş kazanır) aynı parçayı kendi saatinde
  **aynı ana** zamanlar. Ağ dalgalanması bu yüzden duyulan ana değil yalnız «parça zamanında geldi mi»ye yansır; geç kalan parçalar
  sayılır ve hedef (ortak gecikme) kendiliğinden büyür, sakinleşince küçülür. **Beklenen:** ikisi aynı anda duyulur; ince fark
  kalırsa Ayarlar › Ses & Aktarım › «Telefon–DeX ince ayarı» (ya da Mikser'de «İkisi» satırının altında) ile ayarla: + telefonu
  geciktirir, − öne alır; değer kaydedilir ve canlı uygulanır. Doğrulanması gerekenler (yalnız cihazda): (1) kart/durum satırı
  «aynı anda çalıyor (ortak gecikme ≈ N ms)» demeli; «hizalanamadı» diyorsa telefon AudioTrack'i kuramamıştır (kabuk kimliği
  HyperOS'ta reddedilmiş olabilir) — uygulama telefonda eskisi gibi çalar, günlükte `[PhoneRender]` satırı nedenini söyler, bildir;
  (2) Windows'ta WebView2'nin `AudioContext.getOutputTimestamp()` değeri makul olmalı — ses telefondan belirgin önde/geride kalıyorsa
  bildir (yedek yol: bildirilen çıkış gecikmesi kullanılır); (3) gecikme farkı kablolu (USB) ve Wi-Fi'da ayrı ayrı denenmeli —
  saat ölçümü gidiş-dönüşün yarısı kadar belirsizdir (USB'de ≈ 2–5 ms, Wi-Fi'da daha fazla); (4) rotayı «DeX»e/«Telefon»a alınca
  telefondaki kopya **hemen** susmalı; (5) PC çıkışı Bluetooth kulaklığa alınınca hedef kendiliğinden artmalı.
  **Art arda küçük kesilmeler (düzeltildi — jar YENİDEN DERLENMELİ):** ilk sürümde parçanın zaman damgası `AudioRecord.read()`'in
  döndüğü anda alınıyordu; bu an birkaç ms (patlamalar halinde) oynar. Hem DeX sayfası hem telefon her parçayı kendi damgasına göre
  yeniden yerleştirdiği için bu oynama her 1–2 parçada küçük bir sessizlik/atlama olarak duyuluyordu (aynı gürültüyle ölçüm: 300 parçada
  163 kesilme). Şimdi damga, çipin örnek sayacından türeyen **tek bir zaman çizgisi** (`PtsClock`: alt zarf süzgeci, yalnız gerçek
  kayıp/yeniden başlamada yeniden demirler) ve sayfa bir parçayı ancak son 12 parçanın **ortancası** 10 ms'den fazla saptığında bir kez
  düzeltiyor (büyük bir sıçrama — hedef değişimi — anında). **Beklenen:** «İkisi»de hiç kesilme yok; yalnız başlangıçta (ilk ~2 sn, hedef
  gerçek çıkış gecikmesine oturur) tek tük küçük bir atlama normaldir. Jar yenilenmeden yalnız sayfa tarafı iyileşir (163 → ≈ 1).
  **Telefon DeX'ten «bir tık» önde (düzeltme: ölçüm — jar YENİDEN DERLENMELİ):** iki taraf aynı ana hedefler ama her biri yalnız kendi
  platformunun bildirdiğini bilir: telefonun AudioTrack zaman damgası HAL'de, sayfanınki Windows ses motorunda biter; hoparlörün DSP'si,
  PC sürücüsünün efektleri ve cihaz saati ofsetinin hatası ikisinde de yoktur. Bu pay telefon + PC çiftine **sabit**tir, yazılımdaki
  hiçbir sayı bilemez — kulak ya da mikrofon bilir. Bu yüzden Ayarlar › «Telefon–DeX ince ayarı» altına **«Mikrofonla otomatik ayarla»**
  eklendi: dizüstünün mikrofonu açılır; telefon yükselen (1,5→3,1 kHz), sayfa alçalan (5,1→3,5 kHz) bir 20 ms'lik cıvıltıyı, gerçek sesin
  zamanlandığı aynı düzenekle (`PTS + hedef`) 6 kez çalar; eşleşmiş süzgeç (FFT ile çapraz ilinti) her cıvıltıyı örnek altı doğrulukla
  bulur. İkisi AYNI kayıtta olduğundan mikrofonun kendi gecikmesi sonuca girmez; her çiftin gerçek farkı − planlanan fark = telefonun
  hesaba girmeyen payı β, ince ayar −β olur ve **kendiliğinden yazılır**. Tutarsız çıkarsa (çiftler 3 ms'den fazla ayrışırsa, bir taraf
  duyulmazsa, kayıt kesilirse, mikrofon izni verilmezse) **hiçbir şeye dokunulmaz**, nedeni söylenir. **Nasıl dene:** medyayı duraklat,
  telefonu dizüstünün yanına koy (telefonun medya sesi açık), DeX sesi hoparlörden çıksın (kulaklık takılıysa PC cıvıltısı duyulmaz);
  düğmeye bas, mikrofon iznini ver, ≈ 5 sn bekle. Mesaj «Telefon DeX'ten ≈ N ms önde duyuluyordu; ince ayar +N ms yapıldı» demeli. **Doğrula:**
  (1) düğmeye bir kez daha bas — «zaten hizalıydı (±1 ms)» demeli; (2) gerçek bir şarkıda kulakla iki taraf aynı anda mı; (3) USB'den
  Wi-Fi'a geçince ayar değişebilir (bağlantının asimetrisi) — ölçümü yeniden çalıştır. Beklenmeyen: WebView2'nin mikrofon izni
  istemi çıkmaması (bildir), HyperOS'ta ikinci bir AudioTrack'in kabuk kimliğiyle kurulamaması (mesaj «Telefon ölçü sesini çalamadı» — bildir).
  Ayrıca sayfa, bir parçayı yeniden yerleştirmeden önceki ölü bandı sabit 10 ms yerine **ölçülen gürültüye** bağladı (temiz zaman çizgisinde
  4 ms'den, gürültülüde 10 ms'ye kadar): sabit 10 ms, ölçüm sonrasında da ±birkaç ms'lik dalgalanma bırakırdı.

## 10. Pil sayfası (Hızlı Ayarlar › Pil Durumu & Teşhis) — telefon yardımcısı (jar) YENİDEN DERLENMELİ
Sayfa artık hiçbir sabit değer göstermez (eskiden «%68», «4.12 V», «Tam şarja tahmini 48 dakika» yer tutucuları vardı). Veri daemon'un
yeni `battery_health` komutundan gelir (`py backend/java/build.py`, sonra OpenDeX'i yeniden başlat); eski jar ile sayfa yalnızca 5 sn'lik
pil bildirimini gösterir ve bunu yazar. Ölçülemeyen satır «—» olur ya da hiç çizilmez; **türetilen** değer «≈ … (tahmini)» der.
**Ne ölçülür / nereden gelir:** şarj kaynağı sınıfı (USB portu / adaptör / PD / kablosuz) çekirdeğin `usb_type` değerinden ve
`dumpsys battery`'deki «Max charging current/voltage» sınırlarından; gerçek akım `BatteryManager` (µA); kalan süre =
(tam − şimdiki) mAh ÷ anlık akım (akım yumuşatılır; %80 sonrası şarj yavaşladığı için «yavaşlar» notu düşer); pil sağlığı sırasıyla
Android 14+ `STATE_OF_HEALTH` → ölçüm çipinin dolu/tasarım oranı → yük sayacı ÷ yüzdeden **tahmin**; döngü sayısı
`EXTRA_CYCLE_COUNT`/çekirdek; ilk kullanım `FIRST_USAGE_DATE` ya da Xiaomi'nin satırı; koruma = Android şarj politikası ya da Xiaomi
bayrakları (AYAR olarak, «sınır şu an işliyor» iddiası değil).
**Kontrol et (POCO X7 Pro, bilgisayar USB portu):** (1) «Şarj Kaynağı» → «Bilgisayar USB portu (SDP) · en çok 2.5 W» ve sarı uyarı «yavaş
şarj»; (2) «Şarj Gücü» ≈ 2 W / ~500 mA ve «Tam doluma ≈ …»; adaptörle ya da hızlı şarjla bu değerler büyümeli; (3) **Pil sağlığı:** bu
telefonda ölçüm çipi «dolu = tasarım» (56573 = 56573) bildiriyor — bu bir tasarım sabitidir, ölçüm değil; bu yüzden sayfa «%100» DEMEZ, yük
sayacından «≈ %9x (tahmini)» gösterir (80 %'de 4431 mAh → ≈ 5539 mAh ⇒ ≈ %92). Android 16 sağlık yüzdesini bildirirse (`STATE_OF_HEALTH`) o
değer «%NN» (tahmini değil) görünür — hangisinin çıktığını bildir; (4) «Kapasite» 5.539 / 6.000 mAh; (5) «Şarj Döngüsü» ve «İlk Kullanım»
yalnızca telefon bildiriyorsa görünür (Xiaomi'nin «22 Eylül 2025» satırı beklenir); (6) «Pil Koruması» → «Açık (Xiaomi)» (bayrak açıksa);
(7) DeX'te video yayınlarken akım **negatif**e dönüp «Kullanımda» + kırmızı «pil boşalıyor» uyarısı çıkıyorsa USB portu tüketimi
karşılamıyor demektir (bu gerçek bir bulgudur, hata değil); (8) pil ≥ 40 °C'de şarjdayken «şarj kısılıyor olabilir» uyarısı; SoC sıcaklığı
termal HAL'den gelir (HyperOS'ta bazen yok — satır o zaman görünmez).
**Kapsam dışı bırakıldı (ürün kararı):** «ekran açık kalma süresi» (DeX oturumunda telefon ekranı kısılı/kapalı, rakam yanıltıcı olurdu;
`dumpsys batterystats` da ağır ve gürültülü) ve üretici adlı rozetler («Xiaomi Anti-Aging»): koruma tek, üreticiden bağımsız satırda.

## 11. Telefon Yükü sayacı: «diğer kabuk komutu» / «Daemon RPC» neyin işi? — telefon yardımcısı (jar) YENİDEN DERLENMELİ

- **Ne değişti:** Telefon Yükü paneli artık kovaların içini gösteriyor — «OpenDeX'in telefona gönderdiği komutlar» altında **«En sık komutlar»**:
  komutun adı (uzun sayılar `#`, yazdığın metin kesilir), kimin taşıdığı (**yardımcı** = telefondaki daemon çalıştırdı, **adb** = adb ile gitti)
  ve dakikadaki sayı. `settings`/`getprop`/`dumpsys battery|power` artık «Diğer kabuk komutu»nda değil **«Cihaz durumu okuma»** kovasında.
  RPC'ler de adıyla görünür (`RPC load_sample`, `RPC states_get` …). **Neden:** «dakikada 32–48 diğer kabuk / 38–54 RPC» tek bir sayıydı;
  kaynağı koddan tahmin etmek yerine ölçüyoruz.
- **Önemli not (sayaç neyi sayar):** «kabuk komutu» sayısı, daemon'a yönlendirilen komutları da içerir (daemon `adb` işlemi başlatmaz ama
  telefon komutu yine çalıştırır; `settings` her çağrıda bir `app_process` başlatır — ucuz değildir). Rozet bunu ayırt eder.
- **Doğrula (jar yenilenmeden de çalışır, yalnız backend + arayüz):** Telefon Yükü panelini aç, 1 dakika bekle, «En sık komutlar»a bak ve
  bana ilk 5 satırı yaz. Beklenen: `RPC load_sample 12` (5 sn'de bir), dakikada ≥ 20 olan başka bir satır varsa asıl kaynak odur.
- **Hızlı Ayarlar durum okuması (`/api/device/states`):** panel yalnız AÇIKKEN 5 sn'de bir sorar (Telefon Yükü paneli açıkken Hızlı Ayarlar
  kapalıdır — iki yüzey birlikte açılamaz). Daemon `states_get` cevap veremezse adb yedek yolu artık **tek** `settings list global` çalıştırır
  (eskiden 4 ayrı `settings get`), cevabı 3 sn saklar, bir anahtar çevrilince önbelleği atar; ve daemon'un verdiği **gerçek hata metni** backend
  günlüğüne bir kez yazılır: `[Devices] daemon durum okuyamadı (states_get: …)`. Bu satırı görürsen bana ilet — varsayım olan «SecurityException:
  Given calling package android does not match caller's uid 2000» o zaman kanıtlanır.
- **Daemon düzeltmesi (jar yenilenince):** `ShellContext` artık kabuk kimlikli (`com.android.shell`) bir `ContentResolver` veriyor; ayarlar önce onunla,
  olmazsa eskisi gibi sistem bağlamıyla okunur (yeni yol eskiyi hiçbir zaman kaldırmaz). Daemon günlüğünde bir kez `[States] toggles are read with
  the shell identity …` ya da `… with the system context (the shell identity failed: …)` yazar. **Doğrulanmadı (yalnız cihazda):** HyperOS'ta
  kabuk kimlikli çözümleyici gerçekten kabul ediliyor mu? İkinci satırı görürsen sebebi o parantezde yazar, bildir.


## 12. Dosya yöneticisi — yalnız gerçek Windows ve gerçek telefonda sınanabilenler

Backend ve arayüz testleri sahte adb / sahte daemon ile koşar; aşağıdakiler Linux CI'da **çalıştırılamaz**. Dosya yöneticisine ya da aktarım motoruna dokunan bir değişiklik için ilgili maddeleri elle işaretle.

**Windows**

- [ ] `SHGetKnownFolderPath`: OneDrive yönlendirmeli Masaüstü / Belgeler klasörleri listeleniyor.
- [ ] Sürücü listesi (`FS_PC_ACCESS=all` kipinde).
- [ ] `\\?\` önekiyle ≥ 260 karakterlik yol açılıyor ve yazılıyor.
- [ ] Telefondan gelen çalıştırılabilir uzantılar (`.exe .msi .bat .ps1 …`) `Zone.Identifier` ile yazılıyor (SmartScreen ilk çalıştırmada soruyor); «Bilgisayarda aç» bu uzantıları hiç çalıştırmıyor.
- [ ] «Sil» Geri Dönüşüm Kutusu'na gidiyor (`send2trash`).
- [ ] Junction / yeniden ayrışma noktası bağ sayılıyor, içine girilmiyor.
- [ ] Kullanımdaki dosya (`WinError 32`) → `in_use`; `a.txt → A.txt` yalnız-büyük/küçük-harf yeniden adlandırması çalışıyor; gizli/sistem öznitelikli dosyalar `hidden` görünüyor.
- [ ] `tauri-plugin-dialog` yerel seçici (klasör, çoklu dosya) çalışıyor; sürükle-bırak koordinatları %125 / %150 ölçekte doğru hedefe düşüyor.
- [ ] Paketli uygulamada CSP önizlemeyi engellemiyor: `<video>` / `<audio>` (`media-src`) oynuyor, PDF / DOCX / XLSX önizlemesi açılıyor.
- [ ] Küçük resimler akarken klasör değiştirmek / iptal etmek takılmıyor (WebView2 HTTP/1.1 bağlantı sınırı).

**Gerçek telefon**

- [ ] adbd `STA2` / `LIS2` (sync v2) ve eski cihazda v1'e dönüş.
- [ ] toybox `find -iname` / `df` / `mv` farkları (daemon yokken yedek yol).
- [ ] Paylaşımlı depolamada büyük/küçük harf duyarsızlığı (FUSE).
- [ ] Küçük resimler (foto, video, albüm kapağı) geliyor; aktarılan dosya Galeri'de görünüyor (MediaScanner).
- [ ] Scoped storage: `Android/data` davranışı beklendiği gibi (erişilemiyorsa nedeni söyleniyor).
- [ ] Wi-Fi koptuğunda aktarım `paused` olup bağlantı dönünce kaldığı yerden sürüyor; yarım dosya kalmıyor.
- [ ] 2 GB'lık video aktarımı ve ortasında iptal; SD kart / USB hacimleri.
- [ ] Eski bir `opendex-tools.jar` ile (`fs` yeteneği yok) yedek yol çalışıyor; yeni jar ile `caps` içinde `fs` görünüyor.
