"""The frontend↔backend route contract, pinned in one file both suites read.

`frontend/tests/fixtures/backend-routes.json` lists every HTTP route (METHOD /api/path, path parameters as `{}`) and
every WebSocket route the backend serves. This test fails when the backend changes without regenerating the manifest;
the frontend's tests/apiContract.test.js fails when the UI calls a route that is not in it. The same goes for what the
input channels ACCEPT (`backend-input-contract.json`): the D-pad posted `kind: "dpad"` to a route that exists but whose
schema refuses it, and the UI swallowed the 422 — a route-only contract cannot see that. Regenerate with:

    UPDATE_ROUTE_MANIFEST=1 python -m pytest tests/test_route_manifest.py
"""
import json
import os
import re
from pathlib import Path

from app.api.v1.endpoints.input import KeyRequest
from app.api.websockets import INPUT_MESSAGE_TYPES, ws_router
from app.input.keyboard_control import _NAMED_KEYCODES
from app.main import create_app

FIXTURES = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures"
MANIFEST = FIXTURES / "backend-routes.json"
INPUT_CONTRACT = FIXTURES / "backend-input-contract.json"


def current_manifest() -> list[str]:
    app = create_app()
    entries = set()
    for path, ops in app.openapi()["paths"].items():
        if path.startswith("/api/v1/"):
            continue                                   # the /api/v1 alias mirrors /api exactly
        for method in ops:
            entries.add(f"{method.upper()} {re.sub(r'{[^}]+}', '{}', path)}")
    for route in ws_router.routes:
        entries.add(f"WS {re.sub(r'{[^}]+}', '{}', route.path)}")
    return sorted(entries)


def test_route_manifest_is_current():
    current = current_manifest()
    if os.environ.get("UPDATE_ROUTE_MANIFEST"):
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(json.dumps(current, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    assert MANIFEST.exists(), f"{MANIFEST} yok — UPDATE_ROUTE_MANIFEST=1 ile üretin"
    pinned = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert pinned == current, (
        "Backend rotaları değişti ama frontend/tests/fixtures/backend-routes.json güncellenmedi. "
        "UPDATE_ROUTE_MANIFEST=1 python -m pytest tests/test_route_manifest.py"
    )


def current_input_contract() -> dict[str, list[str]]:
    """What the input endpoints accept: the `kind` values of POST /api/input/key, the key names `kind: "keycode"` can
    resolve (anything else is a 422) and the /ws/input message types."""
    kinds = KeyRequest.model_json_schema()["properties"]["kind"]["enum"]
    return {
        "key_kinds": sorted(kinds),
        "keycode_names": sorted(_NAMED_KEYCODES),
        "ws_input_types": sorted(INPUT_MESSAGE_TYPES),
    }


def test_input_contract_is_current():
    current = current_input_contract()
    if os.environ.get("UPDATE_ROUTE_MANIFEST"):
        INPUT_CONTRACT.parent.mkdir(parents=True, exist_ok=True)
        INPUT_CONTRACT.write_text(json.dumps(current, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    assert INPUT_CONTRACT.exists(), f"{INPUT_CONTRACT} yok — UPDATE_ROUTE_MANIFEST=1 ile üretin"
    pinned = json.loads(INPUT_CONTRACT.read_text(encoding="utf-8"))
    assert pinned == current, (
        "Giriş kanallarının kabul ettiği değerler değişti ama frontend/tests/fixtures/backend-input-contract.json "
        "güncellenmedi. UPDATE_ROUTE_MANIFEST=1 python -m pytest tests/test_route_manifest.py"
    )
