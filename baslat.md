# OpenDeX — terminalden başlatma
cd C:\Users\asmin\Desktop\opendex_fable\frontend
npm run tauri dev


cd C:\Users\asmin\Desktop\opendex_fable\frontend

npm run dev


conda activate fastapienv
cd C:\Users\asmin\Desktop\opendex_fable\backend
python -m app.main



İki süreç, **bu sırayla**: önce backend (arayüzün ihtiyaç duyduğu API token'ını o üretir), sonra arayüz.
Her komutu kendi klasöründe çalıştır: `python -m app.main` `app` paketini bulunduğun klasörden arar, `npm` de `package.json`'u orada arar.

Önkoşul: telefonda USB hata ayıklama açık, `adb` PATH'te (`adb devices` telefonu göstermeli).

## 1) Backend → http://127.0.0.1:8710

```powershell
conda activate fastapienv
cd C:\Users\asmin\Desktop\opendex_fable\backend
python -m app.main
```

`conda` PATH'te değilse ortamı doğrudan çağır:

```powershell
cd C:\Users\asmin\Desktop\opendex_fable\backend
conda run -n fastapienv --no-capture-output python -m app.main
```

## 2) Arayüz (tarayıcıda) → http://localhost:5173

Yeni bir terminal aç:

```powershell
cd C:\Users\asmin\Desktop\opendex_fable\frontend
npm ci          # yalnızca ilk seferde / paketler değişince
npm run dev
```

Sonra http://localhost:5173 adresini aç. Backend'i Vite'tan **sonra** ilk kez başlattıysan Vite'ı yeniden başlat (token'ı açılışta okur).

## 2b) Arayüz (yerel pencere, Tauri)

Rust + Tauri CLI gerekir. Backend yukarıdaki gibi elle çalışıyor olmalı:

```powershell
cd C:\Users\asmin\Desktop\opendex_fable\frontend
npm run tauri dev
```

Yayın sürümünde sağ tık → İncele (veya F12) açıktır.

## Testler

```powershell
# backend
cd C:\Users\asmin\Desktop\opendex_fable\backend
conda run -n fastapienv python -m pytest -q

# frontend
cd C:\Users\asmin\Desktop\opendex_fable\frontend
npm test
```

## Telefondaki yardımcıyı (jar) yeniden derleme

Java koduna dokunulduysa (Android SDK + JDK gerekir):

```powershell
cd C:\Users\asmin\Desktop\opendex_fable
conda run -n fastapienv python backend\java\build.py
```

Düz, hata ayıklanabilir derleme için `--no-obfuscate` ekle.

## Yayın derlemesi (.msi)

Android SDK, Rust, Nuitka ve bir C derleyicisi olan Windows makinede:

```powershell
cd C:\Users\asmin\Desktop\opendex_fable
conda run -n fastapienv python scripts\build_release.py
```

Düz (obfuscate'siz) derleme: `--no-obfuscate`. Ayrıntı: `docs\BUILD_AND_RELEASE.md`.

## Sık karşılaşılan

| Belirti | Çözüm |
|---|---|
| Arayüz açılıyor ama her istek 401 | Backend'i durdur, önce onu başlat, sonra Vite'ı yeniden başlat |
| `adb devices` boş | Kabloyu / USB hata ayıklamayı / telefondaki izin penceresini kontrol et |
| Port 8710 dolu | Eski backend süreci çalışıyor: `Get-NetTCPConnection -LocalPort 8710` ile bul, kapat |
| `ModuleNotFoundError: app` | Komutu `backend` klasöründen çalıştırmıyorsun |
