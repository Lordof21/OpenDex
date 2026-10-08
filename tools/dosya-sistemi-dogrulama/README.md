# Dosya sistemi — doğrulama araçları

Bu klasör, dosya sistemi/aktarımı özelliğinin **testlerin kendisini sınayan** araçlarını tutar. Üretim kodunun parçası değildir; CI çalıştırmaz. Amaç: "testler yeşil" demenin yeterli olmadığı yerde (veri kaybı, güvenlik sınırları, UI performansı) kanıt üretmek ve bu kanıtı yeniden üretilebilir kılmak.

```
mutasyon/   kaynağı bilerek bozup testlerin yakalayıp yakalamadığına bakar
gorsel/     dosya yöneticisini sahte backend ile gerçek Chromium'da açar: ekran görüntüsü + 50 000 girdi performansı
```

## 1. Mutasyon testi

Her mutasyon kaynakta **tek bir** yeri bozar, ilgili testleri çalıştırır, dosyayı eski hâline geri yazar.

| Sonuç | Anlamı |
|---|---|
| `caught` | Test başarısız oldu — koruma gerçekten test altında. |
| `SURVIVED` | Test geçti — ya test eksik ya da mutant davranışsal olarak **eşdeğer** (aşağıdaki nota bakın). |

Betikler, bozacakları dosyalarda **kaydedilmemiş değişiklik** varsa durur (mutasyon dosyanın o anki hâlini geri yazar). Önce commit'leyin.

```bash
# Python: aktarım motoru, yerel sağlayıcı, kök/bağ sınırları, ad kuralları (backend/ altında pytest çalıştırır)
python tools/dosya-sistemi-dogrulama/mutasyon/mutate_python.py            # hepsi
python tools/dosya-sistemi-dogrulama/mutasyon/mutate_python.py "move"     # adında "move" geçenler

# Java saf sınıflar (FsWire/FsPolicy/FsOps) — PureClassesSelfTest'i JDK ile derler
python tools/dosya-sistemi-dogrulama/mutasyon/mutate_java_pure.py

# Java FsService — gerçek servis, gerçek soket; android-all.jar gerekir
OPENDEX_ANDROID_JAR=/yol/android-all.jar \
  python tools/dosya-sistemi-dogrulama/mutasyon/mutate_java_service.py
```

`android-all.jar` yalnızca derleme için gereken Android API'sidir (Robolectric'in `android-all` artifact'i). Verilmezse servis betiği net bir hata ile çıkar; Python ve saf-Java betikleri ona ihtiyaç duymaz.

### Bilinen eşdeğer mutant

`mutate_python.py` içindeki **"move removes folders that kept files"**: `transfer.py` taşıma sonrası klasör temizliğinde iki yedek koruma (`folder.keep or folder.broken or folder.pending`) bulunur; yalnızca birini kaldırmak davranışı değiştirmez, ikisi birden kaldırıldığında test yakalar. Bu yüzden `SURVIVED` görünmesi beklenen tek satırdır; savunma derinliği bilinçli.

## 2. Görsel doğrulama ve performans

`gorsel/` altındaki harness, dosya yöneticisini **sahte bir backend** (fetch taklidi) ile açar; Tauri/backend/telefon gerekmez.

```bash
# 1) harness'ı başlat (dosyaları geçici olarak frontend/ altına kopyalar, çıkışta siler)
tools/dosya-sistemi-dogrulama/gorsel/run.sh              # http://localhost:5199/harness.html
PORT=5200 tools/dosya-sistemi-dogrulama/gorsel/run.sh

# 2) ayrı bir terminalde — ekran görüntüleri (scenes.json: 34 sahne)
cd tools/dosya-sistemi-dogrulama/gorsel
node snap.cjs                      # hepsi → ./shots/*.png
node snap.cjs scenes.json "dark"   # adında "dark" geçen sahneler

# 3) 50 000 girdilik klasörde performans
node perf.cjs
```

URL parametreleri: `w`, `h` (pencere boyutu), `theme=light|dark`, `loc=phone|dcim|pc|big`, `view=list|grid`.

Ortam değişkenleri (`snap.cjs` ve `perf.cjs` için):

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `HARNESS_URL` | `http://localhost:5199` | Harness adresi |
| `OUT_DIR` | `./shots` | Ekran görüntüsü klasörü (yalnız `snap.cjs`) |
| `PLAYWRIGHT_PATH` | `playwright` | Playwright paketinin yolu (kurulu değilse `npm i -D playwright` yeri) |
| `CHROME_PATH` | — | Chromium yürütülebilir yolu; verilmezse Playwright'ın kendi tarayıcısı |

> **Performans ölçümünü üretim derlemesiyle yapın.** `run.sh` Vite geliştirme sunucusudur; sayılar kat kat kötüdür. Üretim ölçümü için harness yapılandırmasıyla `vite build` + statik sunum kullanın. Ölçülen sayılar (50 000 girdide liste ilk satır ≈ 433 ms, kaydırmada p95 ≈ 16,8 ms, ≈ 24 DOM düğümü) başsız Chromium + yazılım oluşturmayla alınmıştır; gerçek GPU'lu makinede daha iyi, çok zayıf bir makinede farklı olabilir.

## 3. Bu araçların kanıtlamadığı şeyler

Hiçbiri gerçek Windows/Tauri çalışma zamanını ya da gerçek telefonu sınamaz. Elle doğrulanacaklar [`docs/DEVICE_CHECKLIST.md` § 12](../../docs/DEVICE_CHECKLIST.md#12-dosya-yöneticisi--yalnız-gerçek-windows-ve-gerçek-telefonda-sınanabilenler)'de listelidir.

## Belge önizlemesi (PDF, DOCX, XLSX, PPTX)

`gorsel/belgeler/uret.py` küçük gerçek belgeler üretir (yalnız standart kütüphane); `gorsel/run.sh` bunları geçici olarak `frontend/harness-fixtures/` altına koyar ve çıkışta siler. Harness'ta `loc=docs` klasörü ve `belge-*` sahneleri vardır (`PLAYWRIGHT_PATH=… OUT_DIR=… node snap.cjs scenes.json belge-`). Çözücüler **gerçektir** (pdf.js, mammoth, read-excel-file, fflate): üretim CSP'si altında doğrulamak için harness'ı `vite build` ile derleyip `tauri.conf.json`'daki `csp` başlığıyla sunmak yeterlidir — `worker-src 'self' blob:` PDF ve XLSX worker'ları için, `wasm-unsafe-eval` olmaması nedeniyle pdf.js `useWasm: false` ile çalışır.

Ayrıca `loc=medya` (müzik: gerçek WAV, video: oynatılamadı kartı) ve `onizleme-ipucu*` sahneleri (başlık düğmelerinin ipucu aşağı açılır) vardır. Bu Chromium H.264 çözmez; video akışı backend testlerinde (`test_a_phone_video_plays_from_the_phone_by_byte_ranges…`) doğrulanır.
