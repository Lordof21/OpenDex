import os
import sys
import tempfile
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

# Starlette's TestClient sends `Host: testserver`; the origin guard only answers loopback names in production.
os.environ.setdefault("OPENDEX_ALLOWED_HOSTS", '["127.0.0.1", "::1", "localhost", "testserver"]')
# A fixed API token for the suite (never the developer's ~/.opendex/api-token); TestClient presents it by default.
TEST_API_TOKEN = "test-token-" + "0123456789abcdef" * 2
os.environ.setdefault("OPENDEX_API_TOKEN", TEST_API_TOKEN)
# "auto" would pick the patched scrcpy-server once vendor/ has it and change every spawned command line; the suite
# stays on today's behaviour, and the flavor tests (test_opendex_server.py) ask for what they test explicitly.
os.environ.setdefault("OPENDEX_SCRCPY_SERVER_FLAVOR", "upstream")
# create_app() creates the daemon key file on first use; the suite must not leave one in the developer's home.
os.environ.setdefault(
    "OPENDEX_DAEMON_TOKEN_FILE", str(Path(tempfile.mkdtemp(prefix="opendex-tests-")) / "daemon-token")
)

from app.config import Settings  # noqa: E402
from app.storage import settings_db  # noqa: E402

# Tests must be hermetic regardless of a developer's local backend/.env (e.g.
# OPENDEX_ENABLE_FLEX_DISPLAY=true, set for manual real-device testing) —
# every bare Settings() constructed across this suite is meant to get the
# documented, code-level defaults, never whatever a contributor happens to
# have on disk locally. pydantic-settings resolves env_file relative to CWD,
# and pytest's CWD is this same backend/ directory, so without this a local
# .env silently changes what "default Settings()" means inside every test.
Settings.model_config["env_file"] = None


@pytest.fixture
async def tmp_db(tmp_path):
    await settings_db.init(tmp_path / "settings.db")
    yield


@pytest.fixture(autouse=True)
def _test_client_presents_the_api_token(monkeypatch):
    """Every /api and /ws call needs the bearer token (app/api/auth.py). Tests exercise routes, not the lock — the
    client sends it by default; tests of the lock itself drop it with `client.headers.pop("Authorization")`."""
    from starlette.testclient import TestClient

    original_init = TestClient.__init__

    def init_with_token(self, *args, **kwargs):
        headers = dict(kwargs.pop("headers", None) or {})
        if not any(k.lower() == "authorization" for k in headers):
            headers["Authorization"] = f"Bearer {os.environ['OPENDEX_API_TOKEN']}"
        original_init(self, *args, headers=headers, **kwargs)

    monkeypatch.setattr(TestClient, "__init__", init_with_token)
