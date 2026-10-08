#!/usr/bin/env python3
"""Converts the lossless PNG captures of shoot.cjs into the WebP files that are published (≈ 10× smaller at no visible loss).

    python to_webp.py <dir with .png> <output dir>

Quality 90 with the slowest (best) encoder setting: text edges stay crisp; a 3200×1800 capture lands around 150–250 KB, so the whole
set stays a few MB in the repository's history instead of tens.
"""
import sys
from pathlib import Path

from PIL import Image


def main(source: Path, target: Path) -> int:
    target.mkdir(parents=True, exist_ok=True)
    count = 0
    for png in sorted(source.glob("*.png")):
        out = target / f"{png.stem}.webp"
        Image.open(png).convert("RGB").save(out, "WEBP", quality=90, method=6)
        count += 1
        print(f"  {out.name}  {out.stat().st_size // 1024} KB")
    return 0 if count else 1


if __name__ == "__main__":
    raise SystemExit(main(Path(sys.argv[1]), Path(sys.argv[2])))
