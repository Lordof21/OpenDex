"""Transparent OpenDeX app icon: alpha comes straight from the 2048 px source (no tile, no tracing), each ICO frame is
downsampled from that master with Lanczos. Usage: python scripts/make_app_icon.py docs/brand/opendex-logo-source.jpg frontend/src-tauri/icons"""
import sys
import struct
import cv2
import numpy as np
from PIL import Image

SRC, OUT = sys.argv[1:3]
BG_L, INK_L = 244.0, 37.0
INK = (0x28, 0x20, 0x19)
FILL = 0.98          # mark share of the canvas: an app icon is judged against its neighbours, so it fills the frame

rgb = np.asarray(Image.open(SRC).convert('RGB')).astype(np.float32)
lum = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
alpha = np.clip((BG_L - lum) / (BG_L - INK_L), 0.0, 1.0)
alpha[alpha < 0.02] = 0.0                                   # JPEG haze around the mark

ys, xs = np.where(alpha > 0.5)
y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
crop = alpha[y0:y1, x0:x1]
side = int(round(max(crop.shape) / FILL))
master = np.zeros((side, side), np.float32)
oy, ox = (side - crop.shape[0]) // 2, (side - crop.shape[1]) // 2
master[oy:oy + crop.shape[0], ox:ox + crop.shape[1]] = crop
master_img = Image.fromarray((master * 255).round().astype(np.uint8), 'L')


STROKE = 42.0        # measured stroke width of the master (px of `side`)
MIN_STROKE_PX = 1.7  # a hairline thinner than this smears across pixels at small sizes


def frame(size):
    natural = STROKE * size / side
    src = master_img
    if natural < MIN_STROKE_PX:                       # embolden small frames only, in master pixels
        r = int(round((MIN_STROKE_PX - natural) / 2 * side / size))
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
        src = Image.fromarray(cv2.dilate(np.asarray(master_img), k))
    a = src.resize((size, size), Image.LANCZOS)
    out = np.zeros((size, size, 4), np.uint8)
    out[..., :3] = INK
    out[..., 3] = np.asarray(a)
    return Image.fromarray(out, 'RGBA')


frame(512).save(f'{OUT}/icon.png')


def ico_blob(img):
    """Classic 32-bit DIB frame (what the shell picks best for small sizes); the 256 px frame stays PNG-compressed."""
    n = img.width
    if n >= 256:
        import io
        buf = io.BytesIO()
        img.save(buf, 'PNG')
        return buf.getvalue()
    px = np.asarray(img)                                   # RGBA, top-down
    bgra = px[::-1, :, [2, 1, 0, 3]]                        # DIB is bottom-up BGRA
    header = struct.pack('<IiiHHIIiiII', 40, n, n * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    row_bytes = ((n + 31) // 32) * 4
    and_mask = bytes(row_bytes * n)                         # alpha channel carries the shape
    return header + bgra.tobytes() + and_mask


# Windows asks for an exact size and only scales when it has none: 16/20/24/32/40/48/64 = title bar & tray at 100–400 %,
# 24/30/36/48/60/72/96 = taskbar at 100–400 %, 256 = Start pins. First entry is what Tauri decodes as the default RGBA icon.
sizes = [48, 16, 20, 24, 30, 32, 36, 40, 60, 64, 72, 80, 96, 128, 256]
blobs = [(s, ico_blob(frame(s))) for s in sizes]
head = struct.pack('<HHH', 0, 1, len(blobs))
offset = 6 + 16 * len(blobs)
entries, data = b'', b''
for s, blob in blobs:
    entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(blob), offset)
    offset += len(blob)
    data += blob
open(f'{OUT}/icon.ico', 'wb').write(head + entries + data)
print('master', side, 'frames', sizes)
