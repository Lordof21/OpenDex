# Oyun Tuş Düzeni — "Game Station" Tasarım Planı

Durum: 2026-10-15 · Sahibi: ürün · Kapsam: `frontend/src/keymapper/*` (+ `useMouseLook`, `VideoCanvas`, `WorkspaceTaskFrame`)

## 1. Kim için, ne için

PC'de telefon oyunu oynayan kullanıcı (PUBG/CoD Mobile, Genshin, Brawl Stars, MOBA, yarış). Beklentisi: **konsol/emülatör
kalitesinde bir tuş eşleme**. Tuşa bastığında parmağın *tam* istediği noktaya inmesi, fare hızlı da yavaş da aynı
hassasiyetle bakması, bir kez kurduğu düzeni kaybetmemesi, başka oyuna kopyalayabilmesi.

| İhtiyaç | Bugün | Hedef |
|---|---|---|
| "Tuş nereye vuruyor?" net olsun | Tuş kutusunun *ortası* vuruş noktası; büyük yazı kutuyu genişletiyor, ortası belirsiz | Vuruş noktası artı + halka olarak çizilir; etiket noktadan AYRI, kenarda |
| Çizilen yer = gerçek yer | Kaplama kabın tamamına yaslı; video harf kutulu/yakınlaştırılmış ise **kayma** | Kaplama videonun gerçekten çizildiği dikdörtgene oturur; cihaz pikseli okunur |
| Joystick boyutu | Çizim 96 px sabit, gerçek menzil (`radius`) ayrı → görünen ≠ gerçek | Çizilen halka = gerçek menzil; sürgüyle ayarlanır |
| Hızlı fare | Hareket bakış alanı yarıçapına KIRPILIYOR, kalanı kayboluyor | Hareket parçalanır, hiçbir piksel kaybolmaz |
| Hassasiyet | Tek genel çarpan | Genel + düzene özel X/Y ayrı + Y ters |
| Tuş atama | 16 tuşluk sabit liste | "Bir tuşa bas" ile her tuş, fare düğmesi (yan tuşlar dahil), tekerlek |
| Hata güvenliği | Geri alma yok | Geri al/yinele, otomatik kayıt, çakışma uyarısı |
| Hazır başlangıç | Boş tuval | Tür şablonları (nişancı, MOBA, platform, yarış) |
| Paylaşım/taşıma | Yok | Dışa/içe aktar, başka uygulamadan kopyala |
| Oyun hissi | Statik rozet | Basılı tuş yanar, joystick yönü canlı gösterilir, test modu |

## 2. Bugünkü durumun kanıtlı sorunları

1. **Kayma (en önemlisi).** `KeymapperOverlay` düğümleri kabın `%`'sine koyar; motor `rx × deviceW` ile vurur. Tuval
   `object-contain/cover` + yakınlaştırmayla çizildiğinde (`fitModes.js`, `VideoCanvas.mapPointerToDevice` bunu
   hesaba katar) iki eşleme ayrışır: rozet bir yerde, parmak başka yerde.
2. **Belirsiz vuruş noktası.** Tuş rozeti `-translate-1/2` ile ortalanır, rozet genişliği yazıya göre değişir.
3. **Joystick görünen ≠ gerçek.** Çizim `h-24 w-24` sabit; motor `radius × min(w,h)` kullanır. Tek joystick, yalnız WASD.
4. **Hızlı harekette kayıp.** `moveLook`: yarıçap aşılınca `reach = min(len, radius)` — bir karedeki hareket yarıçaptan
   büyükse fazlası atılır (hız tavanı = yarıçap/kare). Her kenar geçişinde `up→down` ayrıca oyun kamerasını sıfırlar.
   Kesirli piksel her karede yuvarlanıp kaybolur.
5. **Atama dar.** `AVAILABLE_KEYS` 16 tuş; Ctrl yasak ama Shift/Alt serbest; yan fare tuşu ve tekerlek yok.
6. **Tek tip davranış.** Sürekli basılı tutma tek seçenek; "bas-aç/bas-kapa" (koşu kilidi), "yürü" (Shift ile yarım itme) yok.

## 3. Tasarım ilkeleri

1. **Gördüğün yere vurur.** Her çizim, motorun kullandığı değerin birebir aynasıdır (konum, menzil, piksel).
2. **Önce basarak öğren.** Tuş seçmek liste taramak değil, o tuşa basmaktır.
3. **Hassas ve hızlı.** Sürükle + yapış (ızgara, merkez, komşu hizası) ve sayısal giriş + ok tuşlarıyla ince ayar.
4. **Geri alınabilir.** Her değişiklik geri alınır; kayıt otomatik.
5. **Oynarken sessiz, düzenlerken zengin.** Oyun sırasında hafif, saydam, basınca canlanan; düzenlerken tam kontrol.
6. **Doğrulanabilir.** Test modu: tuşa bas, düğüm yansın; telefona hiçbir şey gitmez.

## 4. Özellik seti

### 4.1 Düğüm türleri (v2)

| Tür | Alanlar | Not |
|---|---|---|
| `tap` Tuş | `key`, `size` (görsel halka), `mode` (`hold`/`toggle`), `label` | Vuruş noktası = merkez. `toggle`: bas-aç, bas-kapa (koşu kilidi) |
| `dpad` Joystick | `scheme` (`wasd`/`esdf`/`arrows`), `radius` (gerçek menzil), `walkKey`+`walkScale` | Ok tuşları her zaman ek; yürü tuşu itmeyi ölçekler |
| `look` Bakış | `radius`, `sensX`, `sensY`, `invertY` | Tek; yoksa sağ yarı varsayılan |

Tuş adları: harf/rakam/F1..F12/ok/Space/Shift/Alt/Tab/CapsLock, `MouseLeft|Right|Middle|Back|Forward`,
`WheelUp|WheelDown`. Yasak: Ctrl (fareyi bırakır), Esc, Meta.

### 4.2 Atölye (düzenleme modu)

- **Üst çubuk:** Geri al · Yinele · Test · Yapış (ızgara/hiza) · Şablonlar · Aktar ▾ · Bitti.
- **Sol palet:** `+ Tuş`, `+ Joystick`, `+ Bakış` — akıllı yerleşim (boş yer), tuş eklenince atama dinlemesi başlar.
- **Tuval:** videonun gerçek dikdörtgeni; ızgara (isteğe bağlı), merkez çizgileri, hiza çizgileri, seçilen düğümde
  cihaz pikseli (`x 1024 · y 512 px`).
- **Sağ denetçi (Inspector):** seçili düğümün her alanı — tuş (bas-ve-ata), ad, boyut, konum (X/Y %, ok tuşu),
  mod, yürü tuşu, duyarlılık, sil/çoğalt; seçim yokken düzen özeti: duyarlılık, saydamlık, ölçek, çakışmalar.
- **Kısayollar:** ok = 0,5 %, Shift+ok = 0,1 %, Del = sil, Ctrl+D = çoğalt, Ctrl+Z/Y = geri al/yinele, Esc = bitti.
- **Çakışma:** aynı tuş iki düğümde → uyarı rozeti + denetçide açıklama.

### 4.3 Oyun içi HUD

Tuş kapakları (keycap): küçük halka + kenarda etiket, ölçek ve saydamlık ayarlı; basılınca yanar; joystick basılı yönü
gösterir; bakış alanı yalnız düzenlerken görünür; Ctrl serbest/yakalı durumu rozetle (mevcut).

### 4.4 Fare bakışı

- Hareket **parçalanır** (adım ≤ 0,8 × yarıçap); kenara varılırsa parmak merkeze alınır, **kalan hareket merkezden sürer**.
- Kesirli piksel birikir (taşınır), yavaş harekette duraksama olmaz.
- Duyarlılık = genel × düzen X/Y; `invertY`.
- Tekerlek ve yan düğmeler tuş olarak atanabilir.

## 5. Veri modeli ve geçiş

`presets[package]` düğüm dizisi olarak kalır (geri uyumlu). `sanitizeNode` eksik alanları doldurur; eski `tap` düğümlerinin
`radius: 0.1` yan değeri yok sayılır, görsel boyut yeni `size` alanındadır. Arayüz tercihleri (ızgara, yapış, HUD ölçeği)
ayrı anahtarda (`opendex_keymap_ui`). Geri al/yinele bellekte, düzenleme oturumu boyunca.

## 6. Doğruluk ölçütleri (kabul)

1. `fit/fill/cover/zoom` her modunda düğüm merkezi ile motorun vurduğu cihaz pikseli aynı (birim testi: `fitRect` ↔ `mapClickToDeviceCoords`).
2. Bir karede yarıçapın 10 katı fare hareketi gönderildiğinde toplam parmak yer değiştirmesi = girilen hareket (kayıp 0, ±1 px).
3. Yarıçap 90 px iken 1 px'lik 200 ardışık hareket duraksamadan toplam 200 px verir (kesir taşıması).
4. Joystick çizim yarıçapı = motorun hedef noktası uzaklığı.
5. Her düzenleme geri alınır/yinelenir; çakışma uyarısı tuş değişince güncellenir.
6. Tüm değişiklikler `npm test` içinde yeşil; yeni metinler 20 dilde bulunur.

## 7. Fazlar ve durum

| Faz | İçerik | Durum |
|---|---|---|
| 0 | Bu belge | ✅ |
| 1 | Veri modeli (`model.js`), motor: bakış parçalama + kesir taşıma, duyarlılık X/Y, joystick şeması/yürü, bas-aç, tekerlek + yan düğmeler, etkinlik yayını | ✅ (testli) |
| 2 | Atölye: gerçek video dikdörtgeni, denetçi, bas-ve-ata, yapış/hiza, geri al, test modu, şablonlar, aktar | ✅ (testli; **arayüz görsel olarak sende denenecek**) |
| 3 | Oyun içi HUD: basınca yanma, ölçek/saydamlık | ✅ |
| 4 (öneri) | Profiller (aynı oyunda birden çok düzen + kısayolla geçiş), topluluk şablonları | — |

## 8. Uygulama notları (2026-10-15)

- Dosyalar: `keymapper/{model,keymapStore,templates,keycaps,keymapperEngine,useMouseLook}.js`, `keymapper/editor/{Workbench,Inspector,NodeView,KeyCapture,dialogs}.jsx`, `editor/{snapping,useVideoFrame,useKeymapActivity}.js`.
- Testler: `keymapModel`, `keymapStore`, `keymapperEngine` (kayıpsız bakış, şema, yürü, bas-aç, tekerlek, etkinlik), `mouseLookHook`, `keymapEditor` (38 senaryo). Toplam FE 2203 test yeşil.
- Kaplamanın hizası `fitRect` ile kanıtlanır: her `object-fit` + yakınlaştırma modunda çizilen nokta = `mapClickToDeviceCoords` çıktısı (±2 px).
- Yeni 127 metin 20 dilde var; **tr** kaynak, diğer 19 dilde şimdilik **İngilizce** (çeviri bekliyor).
- Workspace görevlerinde cihaz boyutu bilinmediğinden cihaz-piksel gösterimi gizlenir (oranlar aynı).
- Faz 4 (profiller) yapılmadı.
- Etkin / devre dışı: her düğümde `enabled` (devre dışı düğüm düzende kalır, motor+HUD yok sayar); uygulama başına düzen anahtarı `layoutOff` (sohbet yazarken geçici kapat). Atölyede güç düğmesi + denetçi anahtarları, Hub'da (pencere + Workspace görevi) hızlı aç/kapa. Eski ekran-üstü "Yön tuşları" D-pad'i (VisualControls) kaldırıldı; yerindeki hub döşemesi "Tuş düzeni" aç/kapa.
- İpuçları uygulamanın `data-tooltip` sistemiyle (düz `title` yok); sol palet için yeni `data-tooltip-position="right"`.
- Pencereye özel düzen: `layoutKey` (pencerenin kendi düzeni `win:<id>`, yoksa uygulama paketi); atölyede "Bu pencereye özel düzen" anahtarı, "Uygulama düzeni olarak kaydet". Kendi şablonlarım: `userTemplates` (ad, kaydet/uygula/yeniden adlandır/sil, en çok 30).
- Oyun kipi güvenliği: aktif tuş düzeni varken Ctrl+W (kapat) ve Ctrl+M (küçült) pencere kısayolu OLMAZ, oyuna gider (2026-10-16 00:23 olayı); kapatma kaynağı günlüğe yazılır.
