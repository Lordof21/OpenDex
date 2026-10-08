# Simgeleri yönet — doğrulama araçları

Masaüstü → sağ tık → **Simgeleri Yönet** penceresini (`frontend/src/desktop/ManageIconsDialog.jsx`) gerçek Chromium'da ve
**gerçek `Desktop.jsx` ile** sınar; backend/telefon gerekmez (fetch taklidi). Üretim kodunun parçası değildir.

```bash
tools/simgeleri-yonet-dogrulama/run.sh          # http://localhost:5198/harness.html?w=1280&h=760&theme=light|dark&apps=60
cd tools/simgeleri-yonet-dogrulama
node snap.cjs                                    # 10 sahne → ./shots/*.png (açık/koyu, arama, boş durum, geri al, dar, kısa, liste yok)
node snap.cjs koyu                               # adında "koyu" geçen sahneler
node e2e.cjs                                     # anahtar → kaydedilen düzen (PUT /api/layout) → masaüstündeki simgeler → geri al
```

Ortam: `HARNESS_URL` (varsayılan `http://localhost:5198`), `OUT_DIR`, `PLAYWRIGHT_PATH`, `CHROME_PATH` — `dosya-sistemi-dogrulama/gorsel`
araçlarıyla aynı. `run.sh` harness dosyalarını geçici olarak `frontend/` altına kopyalar ve çıkışta siler (`.gitignore`'da kayıtlı).

`snap.cjs` her sahnede pencerenin ekrana sığdığını ve konsolda hata olmadığını da denetler; yalnız görüntü almaz.
