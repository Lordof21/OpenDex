#!/usr/bin/env python3
"""Writes the public OpenAPI document to docs/api/openapi.json (see backend/app/api/openapi_export.py).

    python scripts/export_openapi.py            # rewrite docs/api/openapi.json
    python scripts/export_openapi.py --check    # exit 1 when the committed file is out of date (CI)

The backend is only IMPORTED (no device, no network): the schema comes from the route definitions.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.api.openapi_export import public_schema  # noqa: E402
from app.main import create_app  # noqa: E402

TARGET = ROOT / "docs" / "api" / "openapi.json"


def render() -> str:
    return json.dumps(public_schema(create_app()), indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="do not write; fail when the file is out of date")
    args = parser.parse_args()
    text = render()
    if args.check:
        current = TARGET.read_text(encoding="utf-8") if TARGET.exists() else ""
        if current != text:
            print(f"{TARGET.relative_to(ROOT)} is out of date — run: python scripts/export_openapi.py", file=sys.stderr)
            return 1
        print(f"{TARGET.relative_to(ROOT)} is up to date")
        return 0
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(text, encoding="utf-8")
    print(f"wrote {TARGET.relative_to(ROOT)} ({len(text) // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
