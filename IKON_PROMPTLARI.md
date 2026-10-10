# OpenDeX uygulama ikonları — Gemini prompt seti

Dört ikon: **Dosyalar**, **OpenDeX Ayarları**, **Telefon Ekranını Yansıt**, **Çalışma Alanı (Workspace)**.
Promptlar İngilizce (görsel modeller İngilizcede daha tutarlı). Her prompt tek başına yapıştırılır; önce ORTAK BLOK, sonra ikon bloğu.

## Nasıl kullanılır
1. Her ikon için **yeni bir sohbet** aç (stil birbirine karışmasın), ORTAK BLOK + o ikonun bloğunu tek mesajda yapıştır.
2. İlk sonuç tutmazsa sadece değişikliği yaz ("glyph biraz küçük", "gradient daha az doygun") — baştan yazma.
3. Dört ikonun **ailesi aynı görünsün** diye ikinci, üçüncü, dördüncü ikonda ilk beğendiğin ikonu da yükleyip "same style family as the attached icon" ekle.
4. Çıktıyı PNG 1024×1024 olarak `frontend/public/icons/` altına koy: `files.png`, `settings.png`, `mirror.png`, `workspace.png`. Bağlamayı (AppIcon.jsx) ben yaparım.

## Projenin gerçek renkleri (koddan; açık/koyu tema)
| | Açık tema | Koyu tema |
|---|---|---|
| Arka plan | `#F7F5F1` (sıcak bej) | `#171310` (sıcak koyu kahve) |
| Kart | `#FBFAF8` | `#211D19` |
| Kenarlık | `#CFC9C2` | `#413C36` |
| Vurgu | `#E6D4C6` | `#3F362E` |
| Yazı | `#15110C` | `#F0EEEA` |
| Dosyalar (amber) | `#DCA331` | aynı |
| Ayarlar (arduvaz) | `#525F6B` | `#788897` |
| Yansıt (mavi) | `#0089DB` | aynı |
| Çalışma Alanı (indigo → camgöbeği) | `#5C5BE2` → `#14BBC2` | `#6F73F5` → `#14BBC2` |

İkonlar uygulamada **kare tam-taşma** olarak kullanılır; yuvarlak köşeyi (%22) arayüz keser. Bu yüzden köşe/kenarlık/gölge çizdirmiyoruz, ikon her iki temada da aynı kalacak kadar orta tonda ve doygun.

---

## ORTAK BLOK (her promptun başına)

```
Design a single app icon, 1024x1024 px, square, full-bleed artwork (NO rounded corners, NO outer border, NO drop shadow outside the artwork, NO transparent areas; the whole canvas is filled by the icon background). The app's UI will crop it to a ~22% rounded squircle itself.

Style: modern semi-flat "soft glass" desktop-OS icon, in the family of Fluent / macOS Sequoia / Material You app icons. ONE hero glyph, centered, made of simple geometric shapes with generously rounded corners and optical weight matching a 1.9 px rounded stroke at 24 px (bold, never thin or fussy). Keep the glyph inside the central 58% of the canvas (safe zone) so it survives rounding and tiny sizes. Background: a smooth diagonal linear gradient (145 degrees, light source top-left) between two close tones of the same hue, plus ONE subtle inner highlight along the top edge (a soft white-to-transparent sheen on the upper half, max 18% opacity) and a very soft inner shadow at the bottom. Glyph: slightly lighter or white-cream (#FFFDF8) with a faint soft shadow under it (2-3% of canvas, 25% opacity) for depth. At most 3 colors in total plus white-cream.

It must stay legible and attractive at 24 px, 34 px and 48 px, and look equally good on a warm beige light UI (#F7F5F1) and on a warm near-black dark UI (#171310): mid-tone, saturated background, no pure white edges, no near-black edges, no glow that would vanish on either theme.

Strictly avoid: any text, letters, numbers, watermark, photorealism, 3D clay/plastic look, heavy bevel, noise or grain, rainbow multi-color gradients, busy details, perspective, hands, people, brand logos (no Android robot, no Samsung/Google marks).
```

---

## 1) Dosyalar (`com.opendex.files`)

```
[ORTAK BLOK]

Subject: a file-manager app icon. Hero glyph: an open folder, front panel slightly tilted open, with one small document sheet peeking out of the folder (rounded corners, one short fold line on the sheet). Warm and friendly.

Colors: background gradient from amber #E8B13F (top-left) to deeper amber-orange #B9791F (bottom-right). Folder body: cream #FFF6E2; the folder's back panel a half-tone darker cream #F0D9A8; the paper sheet pure cream #FFFDF8 with a thin amber line. Accent: none besides these.

Mood: trustworthy, tidy, organized. Chunky, simple shapes.
```

## 2) OpenDeX Ayarları (`com.opendex.settings`)

```
[ORTAK BLOK]

Subject: the settings app of a phone-to-desktop workspace ("OpenDeX Settings"). Hero glyph: three horizontal slider tracks with round knobs at different positions (top knob right, middle knob left, bottom knob center), the same idea as the "sliders" icon. Knobs are solid cream circles with a faint inner ring; the tracks are rounded cream bars, the filled part brighter, the unfilled part at 45% opacity. Calm, precise, technical.

Colors: background gradient from slate blue-gray #657483 (top-left) to deep slate #3B4650 (bottom-right). Glyph cream #FFFDF8. One tiny accent: the middle knob gets a warm amber dot (#DCA331) in its center - the project's warm accent.

Mood: quiet, professional, dependable.
```

## 3) Telefon Ekranını Yansıt (`com.opendex.screen_mirror`)

```
[ORTAK BLOK]

Subject: "mirror the phone screen onto the desktop". Hero glyph: a tall rounded smartphone outline (portrait) in the front, and behind it, offset up-left, a wider rounded desktop monitor/window outline (landscape, simple title bar with two tiny dots). Between or across them, two small curved arrows or a small broadcast-wave (three concentric arcs) coming out of the phone toward the monitor to say "mirrored/streamed". Phone screen area is filled with a slightly lighter tint to read as a live screen. No camera notch details, no real device shape, no brand marks.

Colors: background gradient from bright blue #1E9BEA (top-left) to deeper blue #0A5FB0 (bottom-right), with a very subtle cyan tint (#14BBC2) in the bottom-right corner only. Glyph cream #FFFDF8; the back monitor at 60% opacity so the phone is the focus.

Mood: instant, live, connected.
```

## 4) Çalışma Alanı / Workspace (`workspace` paketi)

```
[ORTAK BLOK]

Subject: a shared workspace where several apps sit side by side on one screen. Hero glyph: a wide rounded window with a title bar (two tiny dots at its left) as the back layer at low opacity, and in front of it two overlapping rounded cards/panels of different sizes (a taller one on the left, a slightly shorter and lighter one on the right, overlapping by about 15%), suggesting two apps tiled together. Simple, geometric, balanced composition; exactly the same idea as three overlapping windows.

Colors: background gradient from indigo-violet #5C5BE2 (top-left) to teal #14BBC2 (bottom-right), smooth and diagonal (this is the project's workspace identity colors). Back window: cream at 30% opacity with a thin cream outline; left card: solid cream #FFFDF8; right card: cream at 55% opacity with a thin cream outline.

Mood: focused, productive, modern multitasking.
```

---

## İstersen: koyu temaya özel varyant (opsiyonel)
Aynı sohbette, beğendiğin ikon için şunu yaz:
`Make a variant for dark UI: raise background lightness by ~8%, reduce the white sheen to 10%, keep the exact same glyph and composition.`
Çıktıyı `*-dark.png` adıyla kaydet; AppIcon.jsx tema değişimine göre seçer.

## Küçük boyut testi
Her sonucu 34 px ve 24 px'e küçültüp bak: glyph hâlâ tek bakışta okunuyorsa tamam. Okunmuyorsa "glyph 12% larger, fewer details, thicker shapes" yaz.
