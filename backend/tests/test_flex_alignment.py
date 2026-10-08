"""What scrcpy really does with a flex resize request, and where OpenDex learns it."""
import pytest

from app.config import Settings
from app.windows.scrcpy_launcher import ScrcpyServer, flex_constrained_size


@pytest.mark.parametrize(
    "req,alignment,max_size,expected",
    [
        ((1016, 720), 16, 0, (1008, 720)),     # the report's trap: +8 px on a 16-aligned encoder is no change at all
        ((1008, 720), 16, 0, (1008, 720)),
        ((1286, 723), 2, 0, (1286, 722)),      # align DOWN, per axis
        ((1286, 723), 1, 0, (1286, 723)),
        ((10, 10), 16, 0, (16, 16)),           # never below one block
        ((3000, 1200), 16, 1920, (1920, 1200)),  # max_size clips each axis WITHOUT keeping the aspect ratio
        ((1200, 3000), 16, 1920, (1200, 1920)),
        ((1000, 700), 16, 1920, (992, 688)),   # under max_size: alignment only
        ((1000, 700), 0, 0, (1000, 700)),      # a bogus 0 alignment is treated as 1, never a division by zero
    ],
)
def test_flex_constrained_size_matches_scrcpy(req, alignment, max_size, expected):
    assert flex_constrained_size(*req, alignment=alignment, max_size=max_size) == expected


class _Lines:
    def __init__(self, lines):
        self._lines = [line.encode() + b"\n" for line in lines]

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._lines:
            raise StopAsyncIteration
        return self._lines.pop(0)


class _Process:
    def __init__(self, lines):
        self.stdout = _Lines(lines)
        self.returncode = None


class _Adb:
    def __init__(self, lines):
        self._lines = lines

    async def spawn_shell(self, command, serial=None):
        return _Process(self._lines)


async def _spawned(lines, **spawn):
    server = ScrcpyServer(adb=_Adb(lines), settings=Settings(), serial="SER")
    await server.spawn(new_display="1280x720", dpi=200, **spawn)
    await server._log_task
    return server


async def test_the_patched_servers_announcement_gives_the_alignment():
    server = await _spawned(["[server] INFO: Device: x", "[server] INFO: OpenDex: size_alignment=16"])
    assert server.size_alignment == 16


async def test_an_upstream_server_leaves_the_alignment_unknown():
    # Upstream prints it only at DEBUG, in other words; OpenDex does not raise the server's log level to read it.
    server = await _spawned(["[server] DEBUG: Video codec size alignment requirement: 16px"])
    assert server.size_alignment is None


@pytest.mark.parametrize("max_size,expected", [(0, 0), (1920, 1920), (None, Settings().DEFAULT_MAX_SIZE)])
async def test_the_server_remembers_the_max_size_it_was_spawned_with(max_size, expected):
    server = await _spawned([], max_size=max_size)
    assert server.max_size == expected
