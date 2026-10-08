"""The committed public OpenAPI document (docs/api/openapi.json) is the contract third parties build clients against.

It is GENERATED from the routes (app/api/openapi_export.py); this test fails when a route, a request model or a
description changed and the file was not regenerated, so the document cannot silently rot. Regenerate with:

    python scripts/export_openapi.py            (or: UPDATE_OPENAPI=1 python -m pytest tests/test_openapi_snapshot.py)
"""
import json
import os
from pathlib import Path

import pytest

from app.api import auth as api_auth
from app.api.openapi_export import PUBLIC_OPERATIONS, PUBLIC_PREFIX, public_schema
from app.main import create_app

ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT = ROOT / "docs" / "api" / "openapi.json"
HTTP_METHODS = {"get", "post", "put", "patch", "delete"}


@pytest.fixture(scope="module")
def schema():
    return public_schema(create_app())


def test_the_committed_document_is_current(schema):
    rendered = json.dumps(schema, indent=2, ensure_ascii=False) + "\n"
    if os.environ.get("UPDATE_OPENAPI"):
        SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT.write_text(rendered, encoding="utf-8")
    assert SNAPSHOT.exists(), "docs/api/openapi.json yok — python scripts/export_openapi.py"
    assert SNAPSHOT.read_text(encoding="utf-8") == rendered, (
        "docs/api/openapi.json koddan sapmış (rota, istek modeli ya da açıklama değişti). "
        "Yenile: python scripts/export_openapi.py"
    )


def test_only_the_versioned_surface_is_published(schema):
    assert schema["paths"], "no paths"
    assert all(path.startswith(f"{PUBLIC_PREFIX}/") for path in schema["paths"])
    app_paths = {p for p in create_app().openapi()["paths"] if p.startswith(f"{PUBLIC_PREFIX}/")}
    assert set(schema["paths"]) == app_paths                            # nothing versioned was dropped


def test_the_documented_token_exemptions_are_the_ones_the_middleware_has(schema):
    """If auth.py exempts another path, the document must say it needs no token (and the other way round)."""
    assert PUBLIC_OPERATIONS == {p for p in api_auth.EXEMPT_PATHS if p.startswith(f"{PUBLIC_PREFIX}/")}
    for path, ops in schema["paths"].items():
        for method, operation in ops.items():
            if method not in HTTP_METHODS:
                continue
            if path in PUBLIC_OPERATIONS:
                assert operation["security"] == [], f"{method.upper()} {path} is token-free"
            else:
                assert "security" not in operation, f"{method.upper()} {path} inherits the global token requirement"
                assert "401" in operation["responses"] and "403" in operation["responses"]


def test_body_limits_are_documented_on_exactly_the_methods_the_middleware_limits(schema):
    from app.api.hardening import _BODY_METHODS

    limited = {m.lower() for m in _BODY_METHODS}
    for path, ops in schema["paths"].items():
        if path in PUBLIC_OPERATIONS:
            continue
        for method, operation in ops.items():
            if method in HTTP_METHODS:
                assert (("411" in operation["responses"]) == (method in limited)), f"{method.upper()} {path}"


def test_every_shared_reference_resolves(schema):
    text = json.dumps(schema)
    for name in ("Unauthorized", "ForeignOrigin", "LengthRequired", "PayloadTooLarge"):
        assert f"#/components/responses/{name}" in text and name in schema["components"]["responses"]
    assert "ErrorDetail" in schema["components"]["schemas"]
    assert set(schema["components"]["securitySchemes"]) == {"bearerAuth", "tokenQuery"}


def test_the_document_is_valid_openapi_3_1(schema):
    validator = pytest.importorskip("openapi_spec_validator")
    assert schema["openapi"].startswith("3.1")
    validator.validate(schema)


def test_the_documented_token_rules_match_the_code():
    """The prose in info.description must not drift from auth.py's constants."""
    description = public_schema(create_app())["info"]["description"]
    assert str(api_auth.WS_UNAUTHORIZED) in description                        # 4401
    from app.api.origin_guard import WS_POLICY_VIOLATION
    assert str(WS_POLICY_VIOLATION) in description                             # 4403
    assert "~/.opendex/api-token" in description and "OPENDEX_API_TOKEN" in description


def test_the_router_list_the_exporter_reads_is_complete(schema):
    """`x-requires-device` is read from ENDPOINT_ROUTERS; a router missing there would silently lose the marker."""
    from fastapi.routing import APIRoute

    from app.api.openapi_export import ENDPOINT_ROUTERS

    from_routers = {
        (f"{PUBLIC_PREFIX}{r.path}", m.lower())
        for router in ENDPOINT_ROUTERS for r in router.routes if isinstance(r, APIRoute) for m in r.methods
    }
    documented = {
        (path, method) for path, ops in schema["paths"].items() for method in ops
        if method in HTTP_METHODS and path not in PUBLIC_OPERATIONS
    }
    assert documented == from_routers


def test_bound_device_operations_are_marked_and_answer_409(schema):
    marked = [(path, method) for path, ops in schema["paths"].items() for method, op in ops.items()
              if method in HTTP_METHODS and op.get("x-requires-device")]
    assert marked, "no operation is marked as needing a device"
    for path, method in marked:
        assert "409" in schema["paths"][path][method]["responses"], f"{method.upper()} {path}"
    # the guard really is what 409s: the same operation answers 409 "Cihaz bağlı değil." without a phone
    from fastapi.testclient import TestClient

    app = create_app()
    client = TestClient(app, headers={"Authorization": f"Bearer {app.state.api_token}"})
    res = client.get("/api/v1/device/battery")
    assert (res.status_code, res.json()["detail"]) == (409, "Cihaz bağlı değil.")
    assert schema["paths"][f"{PUBLIC_PREFIX}/device/battery"]["get"]["x-requires-device"] is True
    assert "x-requires-device" not in schema["paths"][f"{PUBLIC_PREFIX}/devices"]["get"]      # listing devices needs none
