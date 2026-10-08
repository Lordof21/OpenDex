# Kapak resmi — doğrulama araçları

Masaüstü → sağ tık → **Arka planı değiştir…** penceresini ve kapak katmanını (`frontend/src/desktop/wallpaper/`) gerçek Chromium'da,
**gerçek `Desktop.jsx` + `WallpaperLayer` + `WallpaperDialog` ile** sınar; backend/telefon gerekmez (fetch taklidi). Üretim kodunun parçası değildir.

```bash
tools/kapak-resmi-dogrulama/run.sh        # http://localhost:5199/harness.html?w=1280&h=760&theme=light|dark[&prefs=<json>][&contact=1]
cd tools/kapak-resmi-dogrulama
node snap.cjs                              # tüm sahneler → ./shots/*.png (varsayılan kapak, kontak sayfaları, diyalog sekmeleri, yerleşim, bulanıklık…)
node snap.cjs kontak                       # 14 hazır kapağın açık/koyu kontak sayfası + ÖLÇÜLEN parlaklık (katalogdaki `luma` ile karşılaştırılır)
node e2e.cjs                               # uçtan uca davranış denetimi (aşağıda)
```

Ortam: `HARNESS_URL` (varsayılan `http://localhost:5199`), `OUT_DIR`, `PLAYWRIGHT_PATH`, `CHROME_PATH` — diğer `tools/*-dogrulama` araçlarıyla aynı.
`run.sh` harness dosyalarını geçici olarak `frontend/` altına kopyalar ve çıkışta siler (`.gitignore`'da kayıtlı).

## `e2e.cjs` neleri denetler (gerçek Canvas / IndexedDB / saat)

- Sağ tık menüsü, galeriden seçim anında uygulanır, çapraz geçiş (sırasında 2 katman, sonra 1), yeniden yüklemede kalıcılık, açık/koyu tema.
- Resim ekleme: 6000×3375 → 3840×2160'a küçülür, WebP kodlanır, IndexedDB'de resim + önizleme birlikte durur, yeniden yüklemede depodan gelir.
- Sil / Geri al (IndexedDB'den gerçekten silinir), yerleşim modu anında uygulanır (ek katman yok).
- Hata yolları: metin dosyası, bozuk resim, SVG — anlaşılır Türkçe mesaj, depoya yazılmaz.
- Sürükle-bırak ve Ctrl+V (gerçek `DataTransfer`), klavye (yatay + **düzen tabanlı dikey** ok tuşları; oklar seçmez, Enter seçer).
- Slayt gösterisi (Playwright sahte saati), eski sürüm göçü (`opendex_wallpaper` → yeni anahtar), ızgara yalnız "Düz" kapakta, konsolda hata yok.

`snap.cjs` her sahnede ayrıca diyalogun ekrana sığdığını ve konsolda hata olmadığını denetler.
