# Uygulama çekmecesi — UX araştırması, plan ve görevler

> Hazırlayan: ürün sahibi / ekip lideri bakışıyla. Durum: **plan → uygulama** (görev durumları en altta).
> Kapsam: `frontend/src/taskbar/AppLauncher.jsx` ("Uygulamalar" çekmecesi, `Ctrl/⌘+K`, görev çubuğundaki başlatıcı düğmesi).
> Tasarım dili kaynağı: **Genel DeX ayarları** penceresi (`settings/SettingsPanel.jsx`, `settings/controls.jsx`).

---

## 1. Bugünkü durum (denetim)

Çekmece bugün **düz bir ızgara**: üstte "toplam N uygulama / x sistem y kullanıcı", altta yüzen bir arama kutusu, iki bölüm (sistem / kullanıcı), her uygulama aynı büyüklükte bir simge.

| Alan | Bugün | Sorun |
|---|---|---|
| Hız | Ad / paket içinde `includes` | Sıralama yok (alfabetik sıra korunur): "chr" yazınca Chrome ilk sırada olmayabilir. Türkçe `I/ı` farkı: `toLocaleLowerCase('tr')` iki tarafta farklı katlıyor → "instagram" yazınca **Instagram bulunmayabilir**. |
| Klavye | Yalnız `Esc` | Ok tuşuyla gezinme, `Enter` ile ilk sonucu açma, tuşa basınca aramaya yazma yok. Fare olmadan kullanılamaz. |
| Kişiselleştirme | Yok | Favori / sık kullanılan / gizle yok. 150+ uygulamalı telefonda her seferinde aynı uzun listeyi kaydırmak. |
| Bağlam | Yok | Sağ tık yok; açık uygulamayı kapatma, favoriye alma, gizleme yolu yok. |
| Durum | Yalnız "açık" noktası | Uygulamanın telefona devredilmiş olması, boş/yükleniyor/telefon bağlı değil durumları gösterilmiyor. |
| Tutarlılık | Ayrı bir görsel dil | Ayarlar penceresi (başlık çubuğu, kenar çubuğu, gruplu kartlar, çipler, vurgu) ile aynı aileden değil. |
| Erişilebilirlik | `role=dialog` var; odak tuzağı / odak geri dönüşü / canlı bölge yok | Ekran okuyucu ve klavye kullanıcısı için eksik. |
| Düzen | Sabit `grid-cols-4/6/9` | Pencere genişliğine göre hücre sayısı basamaklı değişir, boşluk israfı. |

Mevcut güçlü yanlar (korunacak): sistem uygulamalarının ayrımı (`SYSTEM_APP_PKGS`), açık uygulama noktası, `Ctrl+K` kısayolu ve Ayarlar odağıyla çakışmanın çözülmüş olması, tek tıkla açma ya da ön plana getirme akışı (`launchApp`).

---

## 2. Araştırma: benzer ürünler ne yapıyor?

| Ürün | Öğrenilen |
|---|---|
| **Windows 11 Başlat** ([ayrıntı](https://www.techradar.com/computing/windows/microsoft-shows-us-discarded-windows-11-start-menu-designs-and-im-so-glad-they-were-chucked-in-the-bin-in-favor-of-the-revamp-were-getting), [yorum](https://pureinfotech.com/windows-11-new-start-menu-good-bad/)) | Üç katman: **Sabitlenenler → Önerilenler → Tüm uygulamalar**. Canlı kutucuklar kaldırıldı (statik simge). "Önerilen" akışı kapatılabilsin diye yıllarca talep edildi → **kişiselleştirme kapatılabilir olmalı**. Reklam/gürültü eleştirisi: içerik sadeliği. 300 kişilik testle yeniden tasarlandı: tam sayfa düzen, kategoriler. |
| **ChromeOS başlatıcı** ([Chrome OS 100](https://www.trustedreviews.com/news/chrome-os-100-features-new-launcher-is-the-star-of-the-show-4222147), [Android Central](https://www.androidcentral.com/chrome-os-100-announcement)) | **Arama önce**: en çok kullanılan uygulamalar arama kutusunun hemen altında. Sonuçlar **türe göre gruplu** ("alfabe çorbası" eleştirisi). Sıralama: ada / renge / elle. Kompakt, pencereleri örtmeyen yerleşim. |
| **Samsung DeX** ([Samsung](https://www.samsung.com/us/support/answer/ANS10002880/), [Android Central](https://www.androidcentral.com/how-apps-work-samsung-dex)) | Ana ekranda arama çubuğu, uygulamayı masaüstüne sürükleme, sağ tıkla kısayol/kaldırma, "Son kullanılanlar" kısayolu. Telefon alışkanlığının masaüstüne taşınması. |
| **Klavye / erişilebilirlik** ([Microsoft](https://learn.microsoft.com/en-my/WINDOWS/APPS/design/accessibility/keyboard-accessibility), [Android](https://developer.android.com/training/keyboard-input/navigation?hl=nb), [GNOME HIG](https://developer.gnome.org/hig/guidelines/keyboard.html)) | İlişkili düğme grubunda **ok tuşu gezinmesi**; sistemin tahmini yönün yanlış çıkabilir → her hücreden dört yön denenmeli; **başlangıç odağı yıkıcı eylemde olmamalı**; sık eylemlere kısayol, hepsine değil; `Ctrl+harf` standart dışı kısayol için. |

(Araştırmada bulunamayan: frecency sıralaması ve macOS Launchpad/Spotlight eleştirisi için kaynak çıkmadı; ilgili kararlar ürün deneyimine dayanır ve aşağıda **varsayım** diye işaretlidir.)

**Varsayım** — Launchpad'in yıllarca eleştirilen yanı, aramaya geçmeden bir dizi sayfada gezdirmesiydi; en hızlı yol "yaz + Enter". Bu yüzden çekmece **arama-öncelikli** olacak: açılır açılmaz yazılabilir, `Enter` en iyi sonucu açar.

---

## 3. Kullanıcı işleri (JTBD) ve ilkeler

1. **"Şunu hemen aç."** → yaz + Enter (klavye) ya da favori / sık kullanılan satırından tek tık.
2. **"Her gün kullandıklarım elimin altında olsun."** → Favoriler (elle) + Sık kullanılanlar (otomatik).
3. **"Hepsine göz atayım."** → A–Z, yapışkan harf başlıkları, sağda harf dizini.
4. **"Gürültüyü gizle."** → Gizle / Göster, "Gizli" görünümü, sistem uygulamaları süzgeci.
5. **"Ne açık, ne telefonda?"** → açık noktası, "Telefonda" rozeti; açık olanı buradan kapatma.
6. **"Liste güncel mi?"** → Yenile (yeni / kaldırılan sayısını söyler).

İlkeler:
- **Önce klavye, ama fare de birinci sınıf.** Her şey iki yoldan.
- **Sıfır yapılandırma değeri**: ilk açılışta bile düzenli (A–Z + sistem ayrımı); öğrendikçe zenginleşir (sık kullanılanlar).
- **Kişiselleştirme kapatılabilir**: "Sık kullanılanlar" gizlenebilir (Windows 11 dersi).
- **Ayarlar ile aynı aile**: başlık çubuğu, kenar çubuğu, gruplu kart dili, çipler, vurgu, odak halkası.
- **Hareket yalnız `transform/opacity`**, "hareketi azalt" tercihine saygılı (projedeki kural).
- **Hiçbir yıkıcı eylem varsayılan odakta değil** (Kapat bağlam menüsünde, ilk öğe "Aç").

---

## 4. Tasarım

### 4.1 Yerleşim (Ayarlar penceresinin dilinden)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [D]  Uygulamalar            [ 🔍 Uygulamalarda ara…        Ctrl K ]  ▦ ☰ ⟳ ✕ │  ← h-12, bg-muted/40, border-b border-border/70
│      142 uygulama · 3 açık                                                  │
├──────────────┬───────────────────────────────────────────────────────────┤
│ Tümü     142 │  FAVORİLER                                                  │
│ Favoriler  5 │  ▢ ▢ ▢ ▢ ▢                                                  │
│ Sık kull.  8 │  SIK KULLANILANLAR                                          │
│ Açık       3 │  ▢ ▢ ▢ ▢ ▢ ▢ ▢ ▢                                            │
│ Sistem    14 │  TÜM UYGULAMALAR                                          A │
│ Gizli      2 │  A ─────────                                              B │
│              │  ▢ ▢ ▢ ▢ …                                                 C │
└──────────────┴───────────────────────────────────────────────────────────┘
```

- **Başlık çubuğu** (Ayarlar ile aynı): marka karesi, başlık + alt başlık ("142 uygulama · 3 açık"), ortada arama alanı (`Ctrl K` ipucu), sağda görünüm (ızgara/liste), yenile, kapat.
- **Kenar çubuğu** (Ayarlar `SideNav` dili): Tümü / Favoriler / Sık kullanılanlar / Açık / Sistem / Gizli, her birinin sayısı. Dar pencerede yatay çip satırına döner.
- **İçerik**: `Group` kart dili değil ızgara (kart yalnız bölüm başlıklarında etiket olarak: `text-[10px] font-semibold uppercase tracking-[0.12em]`). Hücre ızgarası `auto-fill, minmax(92px, 1fr)` (genişliğe göre akıcı).
- **Harf dizini** (sağda, yalnız "Tümü" ve arama yokken): tıkla → o harfe kay; imleç üstündeyken büyür.
- **Boş / yükleniyor / hata durumları**: iskelet ızgara; "telefon bağlı değil" kartı + Yenile; "sonuç yok" + öneri çipleri (Ayarlar'daki gibi).

### 4.2 Arama (arama-öncelikli)

- Açılınca odak arama alanında. **Çekmece açıkken herhangi bir yazılabilir tuş aramaya yazar** (odak ızgaradayken bile).
- Sıralama (`rankApps`): her sözcük **VE** ile eşleşmeli; puan = ad başı (100) > sözcük başı (80) > ad içinde (50) > paket adı (20); + **frecency** (en çok +15) + favori (+5) + açık (+3); eşitlikte ad sırası.
- Türkçe duyarlı katlama (`fold`: `ı/İ/i`, `ç ğ ö ş ü` aksansız yazıma da eşleşir) — bugünkü `I/ı` hatası kapanır.
- Eşleşen harfler vurgulanır (Ayarlar'ın `Highlight` bileşeni). İlk sonuç **seçili** gelir (halka + "Enter ile aç" ipucu).
- Sonuç sayısı `role="status"` canlı bölgede ("3 sonuç").
- `Esc`: önce aramayı temizler, ikinci basış kapatır.

### 4.3 Klavye

| Tuş | Eylem |
|---|---|
| yazı | aramaya yazar (nerede olursa) |
| ↑ ↓ ← → | ızgarada uzamsal gezinme (her hücreden dört yön); arama alanından ↓ ilk öğeye |
| Home / End | ilk / son öğe |
| PageUp / PageDown | bir ekran |
| Enter | seçili uygulamayı açar; arama varken ilk sonucu |
| Shift+F10 / Menü tuşu / sağ tık / basılı tut | bağlam menüsü |
| Esc | aramayı temizle → kapat |
| Ctrl/⌘ K | aç/kapat (var olan) |
| / | aramaya odaklan |

Odak, kapanınca **çekmeceyi açan öğeye** döner. Çekmece içinde Tab odak tuzağı: arama → kenar çubuğu → ızgara → arama.

### 4.4 Uygulama düğmesi (ızgara ve liste)

- Izgara: simge (48), ad (tek satır, kesilir), **açık noktası**, **favori yıldızı** (yalnız favoride), **"Telefonda"** çipi (devredilmiş).
- Liste: simge 28, ad + paket (mono, soluk), sağda çipler; satır yüksekliği 44.
- Hover/odak: halka (`ring-ring`), `bg-accent/60`; yalnız `transform` ile hafif yükselme.
- Basılı tutma (dokunmatik dahil) bağlam menüsü açar; tıklama açar.

### 4.5 Bağlam menüsü

Aç · Favorilere ekle / Favorilerden çıkar · Gizle / Göster · (açıksa) Pencereyi kapat. Mevcut `ui/ChoiceMenu` değil; Ayarlar/taskbar'ın `PanelShell` dili: `rounded-xl border-border/70 bg-popover`, satır 32 px, `role="menu"`, ok tuşları, Esc.
**Sonraya**: "Masaüstüne ekle" (masaüstü düzeni `Desktop.jsx` içinde yaşıyor; ayrı bir "düzen deposu" gerektirir — ayrı iş).

### 4.6 Veri ve kalıcılık

`launcherStore` (zustand, `localStorage` anahtarı `opendex_launcher_v1`; okuma/yazma try/catch'li, bozuk veri varsayılana döner):
`favorites: string[]` (sıralı), `hidden: string[]`, `usage: { [pkg]: { score, last } }`, `view: 'grid'|'list'`, `showFrequent: boolean`.

Frecency: üstel azalan sayaç, yarı ömür 14 gün — `score = score·0.5^(Δgün/14) + 1` (her açılışta). Kayıt noktası tek: `windowStore.openWindow` (masaüstü simgesi, bildirim, çekmece, görev çubuğu — hepsi sayılır) + çekmeceden "mevcut pencereyi öne getirme".

Yereldir (cihaz/kullanıcı bağımsız yedek yok); ileride backend `app_layout` ile birleştirilebilir.

### 4.7 Hareket ve performans

- Giriş: opaklık + `y 8 → 0` + `scale .985 → 1` (Ayarlar penceresiyle aynı yay). Çıkış kısa. `useReducedMotion` → yalnız opaklık.
- 300 uygulamada: bölümler `content-visibility: auto`; simge `AppIcon` (img, tembel); liste `useMemo`; arama anlık (≤ 1 ms/uygulama).
- Odak halkası ve vurgu yalnız `box-shadow/opacity` (yeniden akış yok).

### 4.8 Erişilebilirlik

`role=dialog aria-modal` · başlık `aria-labelledby` · ızgara `role="group"` + her düğme `aria-label="Ad, açık / favori"` · canlı bölge · odak tuzağı · odak geri dönüşü · renk tek başına anlam taşımaz (açık = nokta + `aria-label`).

### 4.9 Metinler (i18n)

Yeni anahtarlar `launcher.*` grubu; yalnız **tr + en** (`npm run i18n:addkeys`), `docs/CEVIRI_MEMORY.md`'ye işlenir; diğer 18 dil sonra toplu çevrilir (projenin kuralı).

---

## 5. Kapsam dışı / sonraki tur

- Masaüstüne ekle / sürükle-bırak ile favori sıralama / klasörler.
- Otomatik kategori (sosyal, oyun…): Android paket verisi (`AppInfo`) yalnız `package + display_name` taşıyor; kategori için backend alanı gerekir.
- Uygulama bilgisi (sürüm, boyut), kaldırma.
- Web araması / dosya araması birleştirme (ChromeOS tarzı); "Ayarlar" sonuçlarını çekmece aramasına katma (**öneri**: `Ctrl K` → ayar sonucu da göstermek çok değerli, ama iki aramayı birleştirmek ayrı karar).
- Dokunmatik kaydırma dizini.

---

## 6. Görevler (T1–T14) ve kabul ölçütleri

| # | Görev | Çıktı | Kabul ölçütü |
|---|---|---|---|
| T1 | Saf model | `taskbar/launcher/launcherModel.js` | `fold`, sınıflama (sistem/kullanıcı), `rankApps`, `frecencyScore`, harf grupları, bölüm kurucu, uzamsal odak (`nextIndex`) birim testli; Türkçe `I/ı` regresyon testi. |
| T2 | Depo | `taskbar/launcher/launcherStore.js` | Favori/gizle/kullanım/görünüm kalıcı; bozuk JSON'da çökmez; `recordLaunch` azalan sayaç. |
| T3 | Kabuk + başlık | `AppLauncher.jsx` | Ayarlar dilinde başlık çubuğu; arama alanı, görünüm düğmesi, yenile, kapat; açılışta arama odakta. |
| T4 | Kenar çubuğu | `LauncherRail.jsx` | 6 görünüm + sayılar; dar ekranda çip satırı; `aria-current`. |
| T5 | Gezinti görünümü | `LauncherBrowse.jsx` | Favoriler / Sık kullanılanlar / A–Z yapışkan başlıklar / harf dizini; süzgeçler. |
| T6 | Arama görünümü | `LauncherResults.jsx` | Sıralı düz liste, vurgu, ilk sonuç seçili, Enter açar, canlı bölge, boş durum. |
| T7 | Düğme | `LauncherTile.jsx` | Izgara + liste; açık/favori/Telefonda; basılı tut/sağ tık. |
| T8 | Klavye | `useLauncherKeys.js` | Yaz→ara, 4 yön, Home/End/PageUp/Down, Enter, Esc iki aşamalı, `/`, odak tuzağı, odak geri dönüşü. |
| T9 | Bağlam menüsü | `LauncherMenu.jsx` | Aç / Favori / Gizle / Kapat; ok + Esc; `role=menu`. |
| T10 | Kullanım kaydı | `lifecycleSlice.openWindow` + launcher | Her açılış frecency'yi artırır (tek kaynak). |
| T11 | Taskbar entegrasyonu | `Taskbar.jsx` | Yeni sözleşme: `apps, openIds, handoffIds, onLaunch, onCloseApp, onRefresh`; sorgu çekmece içinde. |
| T12 | i18n | `launcher.*` tr+en | `npm run i18n:addkeys`, `CEVIRI_MEMORY.md`. |
| T13 | Testler | model, depo, bileşen, taskbar | Klavye/arama/menü/favori/gizle akışları; tam paket yeşil + `npm run build`. |
| T14 | Belgeler | bu dosya + bellek | Durum tablosu güncel, "sonra" listesi. |

---

## 7. Durum (2026-10-28)

| # | Görev | Durum | Not |
|---|---|---|---|
| T1 | Saf model | ✅ | `launcher/launcherModel.js` — 17 test |
| T2 | Depo | ✅ | `launcher/launcherStore.js` — 7 test |
| T3 | Kabuk + başlık | ✅ | `AppLauncher.jsx` |
| T4 | Kenar çubuğu | ✅ | `launcher/LauncherRail.jsx` |
| T5 + T6 | Gezinti + arama görünümü | ✅ | tek dosyada: `launcher/LauncherSections.jsx` (plandaki iki dosya birleştirildi: ortak ızgara / başlık / boş durum kodu) |
| T7 | Düğme | ✅ | `launcher/LauncherTile.jsx` (ızgara + liste) |
| T8 | Klavye | ✅ | ayrı kanca yerine `AppLauncher.jsx` içinde (combobox durumuna sıkı bağlı) |
| T9 | Bağlam menüsü | ✅ | `launcher/LauncherMenu.jsx` |
| T10 | Kullanım kaydı | ✅ | `windowStore.openWindow` + çekmece (açık pencereyi öne getirme / Ayarlar); çift sayım yok |
| T11 | Taskbar entegrasyonu | ✅ | yeni props: `appsLoaded, onCloseApp, onRefresh, openAppIds, handoffAppIds`; Çalışma Alanı üyeleri "açık" sayılır |
| T12 | i18n | ✅ | 50 anahtar (tr + en); 18 dilde çeviri bekliyor (`CEVIRI_MEMORY.md`) |
| T13 | Testler | ✅ | model 17 · depo 7 · bileşen 27 · görev çubuğu entegrasyonu 2; tam paket (2623) + build yeşil |
| T14 | Belgeler | ✅ | bu dosya + bellek |

Test sırasında bulunan gerçek hata: odak geri dönüşü, açıcı öğeyi efektte okuyordu; arama kutusunun `autoFocus`u o ana kadar odağı almış oluyordu (açıcı = kutunun kendisi). İlk çizimde okunacak şekilde düzeltildi.

**Ekranda doğrulama bekliyor** (kullanıcı gözüyle): yerleşim ve boşluklar, kenar çubuğu ↔ çip satırı geçişi (`md`), harf dizini, liste görünümü, hareket, açık / koyu tema.

### Sonraki tur adayları
Bkz. bölüm 5. Öncelik önerisi: (1) Masaüstüne ekle (masaüstü düzenini ortak depoya taşıma), (2) çekmece aramasında Ayarlar sonuçları (Ctrl+K ile tek giriş), (3) favorileri sürükleyerek sıralama.
