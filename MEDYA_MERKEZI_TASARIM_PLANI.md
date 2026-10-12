# Medya Merkezi — Sıfırdan Tasarım Planı ("Afiş")

Tarih: 2026-10-12 · Kapsam: görev çubuğu medya panelinin ön yüz mimarisi + UI/UX + hareket sistemi.

## 1. Araştırma özeti

| Kaynak | Ne alındı |
|---|---|
| iOS 26 kilit ekranı / Apple Music | Kapak **tam genişlik (full-bleed)**, denetimler kapağın altında sakin bir yüzeyde; kapak "canlı" (yavaş hareket) — içerik kahraman, krom geri planda. |
| Material 3 Expressive | Durum değişimini **şekil dönüşümüyle** anlatan düğmeler (basılı/normal şekil), yaylı (spring) basma geri bildirimi. |
| Chrome "Animating a blur" | Blur yarıçapını canlandırmak 60 fps altına düşürür; bulanık öğe her karede yeniden bulanıklaştırılır. Çözüm: blur'u **statik** tutmak, yalnız opacity/transform canlandırmak. |
| backdrop-filter notları (MDN / web.dev / Webflow) | `backdrop-filter` taşıyan kapsayıcıyı dönüştürmek ve altında hareketli içerik olması pahalı/kararsız; bulanık katman sabit kalmalı. |
| Emil Kowalski ilkeleri | Varsayılan **ease-out**, UI hareketleri ≤300 ms, basmada `scale(0.97)`, girişler `scale(0.95)`'ten (0'dan değil), basma/bırakma asimetrik. |
| Framer Motion pratikleri | Yalnız transform/opacity; `layout` (FLIP) gereksizse kullanma; `will-change` tek katmanda. |
| Veri (daemon `OpenDexDaemon.java`) | Oturum başına `title, artist, album, album_art, state (PLAYING/PAUSED/BUFFERING), position, duration, speed` geliyor — **albüm** ve **arabellek** durumu bugüne dek arayüzde hiç kullanılmıyordu. |

## 2. Önceki sürümün teşhisi (neden takılıyordu, neden sıradandı)

1. **Aurora lekeleri:** `blur-3xl` (64 px) iki katman sonsuz `transform` animasyonuyla, `backdrop-blur-2xl` panelin üstünde → her karede büyük alan yeniden bulanıklaştırma. **Takılmanın ana nedeni.**
2. **Başlık geçişi:** `filter: blur()` canlandırılıyordu (paint işi) ve `AnimatePresence mode="wait"` yeni başlığı eskisinin çıkışını bekletiyordu → ~200 ms boşluk.
3. **Arka plan kapak:** tam panel `blur-3xl saturate` görsel + üstünde ikinci bir `backdrop-filter`.
4. **Nefes ışığı (`media-breathe`)**: bulanık bir katmanda sürekli opacity+scale.
5. **Tasarım:** plak metaforu skeuomorfik bir oyuncak; tipografi sistemin geri kalanından farksız; bilgi hiyerarşisi (uygulama/ses yolu/kaydırıcı/denetim) eşit ağırlıkta.

## 3. Konsept: "Afiş"

Panel bir **dergi kapağı / konser afişi** gibi: kapak panelin tepesinde kenardan kenara, alt kenarı panelin kapaktan türeyen yüzey rengine erir; şarkı adı bu erime bölgesine **Instrument Serif** (sistemin zaten yüklü ama hiç kullanılmayan display yazısı) ile büyük harf boyutunda oturur. Krom yok denecek kadar az; hiyerarşi: **kapak → ad → zaman → oynat → diğer akışlar**.

Şaşırtan ayrıntılar:
- **Yaşayan kapak:** çalarken kapak 26 sn'lik "Ken Burns" kaymasıyla nefes alır (tek compositor katmanı); duraklatınca donar ve hafifçe kararır.
- **Oynat ⇄ Duraklat glifi dönüşür:** üçgen ortadan ikiye ayrılıp iki çubuğa dönüşür (SVG `d` geçişi, 220 ms).
- **Ad boyutu metne uyar:** kısa adlar 32 px, orta 28 px, uzun 24 px (2 satır sınırı) — afiş tipografisi.
- **Satır maskeli giriş:** yeni şarkının adı maskenin altından yukarı kayar (yalnız transform).
- **Yüzey kapaktan renk alır:** panel zemini `popover` ile kapak renginin %9 karışımı; vurgu (kaydırıcı, oynat) kapak rengi.
- **Kontak tabakası:** diğer oturumlar kapak küçük resimleri olarak yan yana; her birinde ilerleme çizgisi ve köşede oynat düğmesi.
- **Klavye:** `K`/Boşluk oynat-duraklat, `J`/`L` ∓10 sn, `N`/`P` sonraki/önceki (YouTube alışkanlığı).
- **Arabellek durumu:** oynat düğmesinin çevresinde dönen ince halka + "Yükleniyor" etiketi.

## 4. Ölçü sistemi (4 px ızgara)

| Öğe | Değer |
|---|---|
| Panel | `min(392px, 100vw−32px)`, köşe 16 px (PanelShell), opak zemin (backdrop-blur YOK) |
| İç boşluk | yatay 20 px (içerik 352 px), alt 20 px |
| Kapak | tam genişlik; yükseklik = min(**4:3** → 294 px, **34vh**, dar ekranda 4:3). Listeyle panelin ≈%44'ü, 1080p ekranın ≈%30'u. Tek esnek öğe: sığmazsa 200 px'e kadar kısalır |
| Kapak üst şeridi | 12 px içeride: sol uygulama rozeti (h-7, simge 18), sağ ses yolu rozeti (h-7) — scrim zemin, blur yok |
| Erime | kapağın üst %55'i tamamen açık; %70'te %30, %84'te %80, altta tam yüzey |
| Başlık bloğu | kapağa −48 px biner; durum satırı 10.5 px/600 BÜYÜK HARF, aralık .14em |
| Ad | Instrument Serif 32/34 · 28/31 · 24/27, `line-clamp-2`, `text-balance` |
| Sanatçı — Albüm | 13 px; sanatçı 600 %82, albüm muted; tek satır |
| Kaydırıcı | süreler satır içi: Plex Mono 11 px, 40 px sütun; iz 4 px → üzerine gelince 6 px; tutamak 14 px |
| Denetim | ⟲10 (36, simge 20) · önceki (44, simge 22) · **oynat (60, glif 26)** · sonraki · 10⟳; aralık 10 px |
| Diğer akışlar | satır listesi: satır 56 px (kapak 44 r10, ad 13/600, sanatçı · uygulama 11.5, ilerleme halkalı oynat 36); liste en fazla **2,5 satır** (148 px), fazlası listede gizli çubukla kayar. **Üzerine gelince:** ad 4 px yükselir, alt satır yukarı kayıp söner, yerine süreli konum kaydırıcısı gelir (220 ms; giriş 70/110 ms gecikmeli, çıkış anında; satır yüksekliği sabit) |

## 5. Hareket tablosu (yalnız transform + opacity)

| Olay | Hareket | Süre / eğri |
|---|---|---|
| Panel açılış | kabuk: Taskbar'ın PANEL_MOTION'u; içerik kademeli: kapak (opacity, scale 1.035→1) → başlık (y 10→0) +50 ms → zaman/denetim +90 ms → akışlar +130 ms | 300 ms, `[0.22,1,0.36,1]` |
| Şarkı/oturum değişimi | yeni kapak üstte belirir (opacity 0→1, scale 1.04→1), eski 260 ms'de söner; ikisi aynı anda (bekleme yok) | 420 ms ease-out |
| Ad değişimi | maskeli: y %60→0 + opacity; çıkan y −%30, 160 ms; `popLayout` (bekleme yok) | 320 ms |
| Oynat ⇄ Duraklat | SVG `d` dönüşümü; düğme basışta 0.94 | 220 ms / 120 ms |
| Çalarken kapak | Ken Burns scale 1→1.07 + hafif kayma, alternatif | 26 sn, duraklayınca durur |
| Duraklatma | kapak üstüne %22 karartma (opacity) | 300 ms |
| Önceki/sonraki | simge basışta 2 px yön kayması | 120 ms |
| Arabellek | düğme çevresinde 1 sn'lik dönen yay | sürekli (yalnız BUFFERING) |
| Hareketi azalt | kademeli giriş, kayma, Ken Burns, dönüş kapalı; yalnız kısa opacity | — |

Aynı anda en fazla iki sürekli animasyon: Ken Burns (1 katman) + ekolayzer (3 küçük çubuk).

## 6. Ön yüz mimarisi

```
src/taskbar/media-center/
  MediaCenter.jsx        panel kabuğu, ortam rengi kapsamı, klavye kısayolları, kademeli giriş
  PosterArt.jsx          tam genişlik kapak: çapraz geçiş katmanları, Ken Burns, karartma, üst rozet şeridi
  TrackHeadline.jsx      durum satırı + uyarlanır serif ad + sanatçı — albüm (maskeli geçiş)
  Transport.jsx          ⟲10 · önceki · PlayPauseGlyph · sonraki · 10⟳, arabellek halkası
  SessionSheet.jsx       diğer akışlar: kontak tabakası döşemeleri
  EmptyStage.jsx         boş / bağlı değil sahnesi
  mediaCenterModel.js    saf kurallar: ad ölçeği, durum, ∓10 sn yüzdesi, kısayol eşlemesi, glif yolları
  choreography.js        hareket sabitleri ve varyantlar
```
- `state/mediaSessions.js`: oturuma `album` ve `buffering` eklenir (daemon zaten gönderiyor).
- `ui/media/Scrubber.jsx`: `size="lg"` ve `times="inline"` eklenir (görev çubuğu kartı etkilenmez).
- Silinen: `MediaStage`, `MediaVinyl`, `MediaStageControls`, `MediaQueue`, `MarqueeText`, plak/aurora/marquee/ripple CSS'i.
- Sözleşme korunur: `MediaCenter` prop'ları, `role=dialog "Medya merkezi"`, bölgeler "Şimdi çalıyor" / "Diğer aktif akışlar", satır etiketi "…, ana oynatıcıya taşı", "Tümünü duraklat", boş durum metinleri.

## 7. Doğrulama

- Birim: model fonksiyonları (ad ölçeği sınırları, durum, kısayollar, yüzde sınırlama, glif yollarının eşit komut sayısı), `album`/`buffering` birleştirme.
- Bileşen: kontratlar (mevcut testler), kısayollar, arabellek halkası, karartma/Ken Burns durumu, kontak tabakası oynat düğmesi oturumu seçmez.
- `vitest` tam takım + `vite build`; sınıfların derlenmiş CSS'te varlığı. Görsel kontrol kullanıcıda.

## 8. Ses yolu menüsü ("Ses nerede çalsın")

Kapak üstündeki ses yolu rozetine basılı tutunca / sağ tıklayınca / ↓ ile açılır (`taskbar/media-center/RouteMenu.jsx`).

| Öğe | Değer |
|---|---|
| Kart | 228 px, köşe 14, iç boşluk 4, zemin `--media-surface` (rozetin `.media-scope` renkleri portala kopyalanır), blur yok |
| Başlık | "SES NEREDE ÇALSIN" 9.5 px/600, aralık .14em |
| Seçenek | 42 px satır: simge kutusu 26 (r8), ad 12/600, açıklama 10.5 muted |
| Seçili | satır ink-faint; simge kutusu ink + on-ink simge; sağda 16 px ink onay dairesi (scale .75→1) |
| Uyarı | (İkisi hizalanamadıysa) bilgi simgeli yumuşak kutu |
| Hareket | rozetin altından, rozet merkezli kökten: opacity + y −4 + scale .97 → 1, 180 ms ease-out |
