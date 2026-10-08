# Medya merkezi — doğrulama araçları

Üretim kodunun parçası değildir; CI çalıştırmaz. Amaç: görev çubuğu medya kartı ile medya merkezinin **gerçek Chromium'da**, açık/koyu temada, her durumda (çalıyor, duraklatıldı, kapak yükleniyor, kapak yok, canlı yayın, çoklu oturum, boş, bağlı değil) ve farklı genişliklerde nasıl göründüğünü ekran görüntüsüyle kanıtlamak. Gerçek `Taskbar` bileşeni sahte bir backend (fetch taklidi) ile çalışır; yani oturum birleştirme, seçim ve eylem yolları üretimdeki kodun aynısıdır.

```
gorsel/run.sh        harness'ı başlatır (geçici dosyaları frontend/ altına kopyalar, çıkışta siler)
gorsel/harness.jsx   sahneler (?scene=playing|paused|pending|noart|multi|live|long), tema (?theme=dark), boyut (?w=&h=)
gorsel/snap.cjs      Playwright ile sahne listesini gezer, PNG üretir
gorsel/scenes.json   27 sahne: widget-* (görev çubuğu kartı, 2x), panel-* (medya merkezi)
```

```bash
cd tools/medya-merkezi-dogrulama/gorsel
./run.sh &                                   # http://localhost:5199/harness.html?scene=multi&theme=dark
PLAYWRIGHT_PATH=/yol/playwright OUT_DIR=/tmp/medya-shots node snap.cjs scenes.json            # hepsi
PLAYWRIGHT_PATH=/yol/playwright OUT_DIR=/tmp/medya-shots node snap.cjs scenes.json panel-multi  # adında "panel-multi" geçenler
```

Ekran görüntüsünde bakılacaklar: başlık/sanatçı metni kapak gölgesi altında soluk kalmıyor mu (konumlu eleman akış içi metnin üstüne boyanır), ortam rengi iki temada okunuyor mu, görev çubuğu kartında başlık kart kenarına değiyor mu, çoklu oturumda panel kaydırma gerektiriyor mu.
