"""The generated documentation cannot drift from the code (scripts/docgen.py), and the hand-written protocol pages
mention everything the code accepts.

Regenerate with `python scripts/docgen.py` — this test fails with that hint when something is out of date."""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import get_args

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"

pytestmark = pytest.mark.skipif(not (ROOT / "docs").is_dir(), reason="docs/ is not part of this checkout (packaged sources)")


@pytest.fixture(scope="module")
def docgen():
    sys.path.insert(0, str(SCRIPTS))
    try:
        import docgen as module
        yield module
    finally:
        sys.path.remove(str(SCRIPTS))


def _without_generated_blocks(text: str) -> str:
    return re.sub(r"<!-- BEGIN GENERATED: (\S+) -->.*?<!-- END GENERATED: \1 -->", "", text, flags=re.DOTALL)


def test_every_generated_file_is_up_to_date(docgen):
    stale = [str(path.relative_to(ROOT)) for path, content in docgen.desired_files().items()
             if not path.exists() or path.read_text(encoding="utf-8") != content]
    assert not stale, f"out of date: {', '.join(stale)} — run: python scripts/docgen.py"


def test_every_event_type_is_in_the_events_table(docgen):
    from app.events import EventType

    block = docgen.events_block()
    listed = set(re.findall(r"^\| `([a-z_0-9]+)` \|", block, flags=re.MULTILINE))
    assert listed == set(get_args(EventType)), "events_block() lost or invented an event — check its parsing of events.py"


def test_every_websocket_route_is_in_the_channel_table(docgen):
    from app.api.websockets import ws_router

    block = docgen.ws_routes_block()
    for route in ws_router.routes:
        assert f"`{route.path}`" in block, route.path


def test_the_events_channel_documents_every_command_it_handles():
    """`/ws/events` client commands are an if/elif chain in api/websockets.py; each one needs a row in docs/API.md."""
    source = (ROOT / "backend" / "app" / "api" / "websockets.py").read_text(encoding="utf-8")
    handled = set(re.findall(r'msg_type == "([a-z_]+)"', source))
    assert handled, "the command chain moved — update this test"
    hand_written = _without_generated_blocks((ROOT / "docs" / "API.md").read_text(encoding="utf-8"))
    for command in handled:
        assert re.search(rf"^\| `{command}` \|", hand_written, flags=re.MULTILINE), f"/ws/events command `{command}` is not documented in docs/API.md"


def test_the_input_channel_documents_every_message_type():
    from app.api.websockets import INPUT_MESSAGE_TYPES

    hand_written = _without_generated_blocks((ROOT / "docs" / "API.md").read_text(encoding="utf-8"))
    for kind in INPUT_MESSAGE_TYPES:
        assert f"`{kind}`" in hand_written, f"/ws/input message type `{kind}` is not documented in docs/API.md"


def test_the_close_codes_in_the_docs_are_the_ones_the_code_uses():
    from app.api.auth import WS_UNAUTHORIZED
    from app.api.origin_guard import WS_POLICY_VIOLATION

    text = (ROOT / "docs" / "API.md").read_text(encoding="utf-8")
    assert f"`{WS_UNAUTHORIZED}`" in text and f"`{WS_POLICY_VIOLATION}`" in text
    assert "`4404`" in text      # the unknown-window close code is a literal in api/websockets.py
    assert 'close(code=4404' in (ROOT / "backend" / "app" / "api" / "websockets.py").read_text(encoding="utf-8")


def test_the_daemon_protocol_page_documents_every_command_and_capability(docgen):
    """Every command the daemon's dispatch understands, every `fs_*` command and every capability it advertises has a
    row (or a mention) in the hand-written part of docs/DAEMON_PROTOCOL.md."""
    facts = docgen.daemon_facts()
    assert len(facts["commands"]) > 30 and len(facts["fs_commands"]) == 9, "daemon_facts() stopped parsing the Java source"
    hand_written = _without_generated_blocks((ROOT / "docs" / "DAEMON_PROTOCOL.md").read_text(encoding="utf-8"))
    for command in facts["commands"] + facts["fs_commands"]:
        assert f"`{command}`" in hand_written, f"daemon command `{command}` is not documented in docs/DAEMON_PROTOCOL.md"
    for capability in facts["capabilities"] + facts["capabilities_token"]:
        generated_only = capability in facts["commands"] or capability in facts["fs_commands"]
        assert generated_only or f"`{capability}`" in hand_written, \
            f"capability flag `{capability}` is neither a documented command nor explained as a flag in docs/DAEMON_PROTOCOL.md"


def test_the_daemon_protocol_constants_in_the_docs_are_the_code_s():
    """The numbers the page states (ports, header sizes, limits) are read from the sources they come from."""
    from app.device import device_daemon_client as client
    from app.streams import app_audio_link as link

    text = (ROOT / "docs" / "DAEMON_PROTOCOL.md").read_text(encoding="utf-8")
    assert str(client.DEFAULT_DAEMON_PORT) in text and str(link.AUDIO_PORT) in text
    assert link.HEADER.size == 16 and "u16 stream_id | u16 flags | u64 pts_us | u32 size" in text
    assert f"{client.HEALTH_CHECK_ATTEMPTS} attempts, {int(client.HEALTH_CHECK_INTERVAL_S)} s apart" in text
    assert f"**{int(client._HANDSHAKE_TIMEOUT_S)} s**" in text
    java = (ROOT / "backend" / "java" / "src" / "com" / "opendex" / "tools")
    wire = (java / "ShellWire.java").read_text(encoding="utf-8")
    assert "MIN_TIMEOUT_MS = 100" in wire and "MAX_TIMEOUT_MS = 120_000" in wire and "MAX_COMMAND_BYTES = 64 * 1024" in wire
    assert "MAX_OUTPUT_BYTES = 8 * 1024 * 1024" in wire and "MAX_RESPONSE_BYTES = 3 * 1024 * 1024" in wire
    assert "AUTH_TIMEOUT_MS = 5000" in (java / "OpenDexDaemon.java").read_text(encoding="utf-8")
