# Translating OpenDeX

The whole UI text of the frontend lives in **one file per language**: `frontend/src/locales/<code>.json`.
`tr.json` (Turkish) is the source; every other file has exactly the same keys. Nothing outside `src/locales/` has to change
to add or improve a language.

## Shipped languages

`tr` (source), `en`, `zh-CN`, `zh-TW`, `hi`, `es`, `pt-BR`, `ru`, `id`, `ja`, `ko`, `de`, `fr`, `it`, `pl`, `vi`, `th`, `uk`, `nl`,
`ku` (Kurmanji, Latin script). The set follows the largest Android / Windows desktop audiences (India, China, the Americas,
Europe, Southeast Asia, Japan, Korea, Russia/Ukraine, Kurdish speakers).

**All non-Turkish files were machine-translated (AI) and have not been reviewed by native speakers.** Please have them
reviewed before a public release, especially `ku`, `hi`, `th` and `vi`, and the sentence fragments that are joined around
bold text (`wireless.*` in `QrPairing.jsx`, `window.opendex_penceresi_kucuk_wxh_daha` + `window.uygulama_penceresini_buyutun_tam`)
— they read naturally in most languages but word order differs, so check them in the UI.

In the UI the language is chosen in taskbar → *Hidden icons* → **Language** (search, native name + name in the current UI
language, “System language” hint, arrow-key navigation). Changing it reloads the app.

## Add a language

```
cd frontend
npm run i18n:add -- pt-BR "Português (Brasil)" pt-BR     # code, the language's own name, locale (BCP 47)
# translate the values in src/locales/pt-BR.json
npm run i18n:status                                       # what is missing / still Turkish / has a broken {{placeholder}}
npm test                                                  # tests/i18nLocales.test.js enforces key + placeholder parity
```

The language shows up in the taskbar → *Hidden icons* panel by itself. The picker sorts by the code in the file name.
Codes are the file name: `de`, `pt-BR`, `zh-CN`, `zh-TW`. A browser/OS tag is matched exactly first (`zh-CN`), then through
aliases (`zh-HK` → `zh-TW`), then to the first file of the same language (`pt-PT` → `pt-BR`, `es-MX` → `es`).

## Rules

- **Keys are never translated, only values.** Do not rename or reorder keys (the files are sorted).
- **Keep `{{placeholders}}` exactly** (same names, any position in the sentence): `"{{count}} pencere daha"` →
  `"{{count}} more windows"`. A test fails if one is dropped or renamed.
- **Meta keys** `@dil.ad` (the language's own name, shown in the picker) and `@dil.yerel` (BCP 47 locale used for dates, numbers
  and sorting) are set per language; `@dil.yerel` must be a valid `Intl` locale (`en-US`, `es-419`, `ku-TR`).
- **Whole sentences, never fragments.** If a Turkish string looks like a fragment (` · şu an {{value}}`), translate it as a
  fragment that can be joined the same way; do not add punctuation the neighbours do not expect.
- **Fit the UI.** Buttons, menu items and chips have fixed room. Aim for at most ~30 % longer than the Turkish text; prefer a
  shorter synonym over truncation. Tooltips and descriptions may be longer.
- **Left-to-right languages only.** Right-to-left scripts (Arabic, Persian, Hebrew, Urdu, Sorani Kurdish) need layout support first
  (window frames, title bars and the taskbar are positioned physically) and are intentionally not shipped yet.
- Only text a user reads is translated. Developer messages, logs and code comments stay as they are.
- Backend error sentences shown in toasts are still Turkish; they are not part of these files yet.

## Glossary (keep these consistent across the whole file)

| Turkish | Meaning in OpenDeX |
|---|---|
| telefon / cihaz | the connected Android phone |
| masaüstü | the desktop (PC side) the phone's apps are shown on |
| pencere | a window showing one phone app on the PC |
| Çalışma Alanı | **Workspace**: one shared screen that holds several app windows |
| Telefona aktar / Telefondan geri al | send an app to the phone's own screen / bring it back to the PC window (*handoff* / *reclaim*) |
| Hub (Pencere Hub'ı) | the per-window quick menu |
| görev çubuğu | taskbar |
| Gizli simgeler | the hidden tray icons panel (chevron) |
| medya merkezi | media center (now playing + controls) |
| yoğunluk / DPI / Dinamik DP | display density; keep `DPI`, `dp` |
| uygulamayı yeniden başlat | restart the app process in its window |
| sayfayı yenile | reload the web page (browsers) |
| bağlantı / hat | connection / link (USB or Wi-Fi) |
| kablosuz | wireless (Wi-Fi) |

**Never translate:** OpenDeX, DeX, Android, Wi‑Fi, Bluetooth, USB, ADB, DPI, FPS, Mbps, PiP, HEVC/H.264/H.265/AV1, app and brand
names (YouTube, Spotify, Chrome…), keyboard key names, units and file extensions.

**Register:** modern, short UI language. Use the polite-but-neutral form that fits each language's software conventions
(for example *vous* in French, *du* in German, *вы* in Russian, です/ます in Japanese, 합니다/하세요 in Korean, *Anda* in Indonesian,
*bạn* in Vietnamese). Imperative for buttons, plain statements for status text.
