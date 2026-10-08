"""The sample world behind the documentation screenshots (tools/screenshots) stays true to the real API.

  * `mock/sample-data.json` is generated from the backend's own models and pure functions — it must be what the generator writes today;
  * every part of it that the OpenAPI document gives a schema (windows, settings, apps, layout, devices, the QR payload) validates;
  * every route the mock backend answers exists in the public OpenAPI document — a renamed or removed endpoint breaks this test
    instead of silently leaving a screenshot that shows an API that is gone.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "screenshots"

pytestmark = pytest.mark.skipif(not TOOL.is_dir(), reason="tools/ is not part of this checkout")

jsonschema = pytest.importorskip("jsonschema")


@pytest.fixture(scope="module")
def spec() -> dict:
    return json.loads((ROOT / "docs" / "api" / "openapi.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def generator():
    sys.path.insert(0, str(TOOL))
    try:
        import gen_fixtures
        yield gen_fixtures
    finally:
        sys.path.remove(str(TOOL))


def _validate(spec: dict, schema: dict, instance: object, what: str) -> None:
    document = {**schema, "components": spec["components"]}      # local $refs (#/components/schemas/…) resolve inside it
    errors = sorted(jsonschema.Draft202012Validator(document).iter_errors(instance), key=lambda e: list(e.path))
    assert not errors, f"{what}: {errors[0].message} at {list(errors[0].path)}"


def _response_schema(spec: dict, path: str, method: str, status: str = "200") -> dict:
    return spec["paths"][f"/api/v1{path}"][method]["responses"][status]["content"]["application/json"]["schema"]


def test_the_committed_sample_data_is_what_the_generator_writes(generator):
    committed = (TOOL / "mock" / "sample-data.json").read_text(encoding="utf-8")
    assert committed == generator.render(), "run: python tools/screenshots/gen_fixtures.py"


def test_the_typed_sample_data_validates_against_the_openapi_schemas(spec, generator):
    data = json.loads(generator.render())
    _validate(spec, _response_schema(spec, "/windows", "get"), data["windows"], "GET /windows")
    _validate(spec, _response_schema(spec, "/windows", "get"), data["workspace_windows"], "GET /windows (Workspace)")
    _validate(spec, _response_schema(spec, "/settings", "get"), data["settings"], "GET /settings")
    _validate(spec, _response_schema(spec, "/apps", "get"), data["apps"], "GET /apps")
    _validate(spec, _response_schema(spec, "/layout", "get"), data["layout"], "GET /layout")
    _validate(spec, _response_schema(spec, "/devices", "get"), data["devices"], "GET /devices")
    _validate(spec, _response_schema(spec, "/devices/known", "get"), data["known_devices"], "GET /devices/known")
    _validate(spec, _response_schema(spec, "/pairing/qr", "post"), data["qr"], "POST /pairing/qr")


def test_every_route_the_mock_backend_answers_is_in_the_public_api(spec):
    source = (TOOL / "mock" / "backend.cjs").read_text(encoding="utf-8")
    declared = set(re.findall(r"^\s+'(GET|POST|PUT|DELETE|PATCH) (/[^']+)':", source, flags=re.MULTILINE))          # the route table
    declared |= {("GET", path) for path in re.findall(r"apiPath === '(/[^']+)'", source)}                          # the streamed ones (fs list/thumb)
    assert len(declared) > 30, "the route table moved — update this test"
    known = {(method.upper(), path.removeprefix("/api/v1")) for path, ops in spec["paths"].items() for method in ops if method in ("get", "post", "put", "patch", "delete")}
    missing = sorted(f"{method} {path}" for method, path in declared if (method, path) not in known)
    assert not missing, f"the mock backend answers routes the API does not have: {missing}"
