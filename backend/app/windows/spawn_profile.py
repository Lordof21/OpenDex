"""How a window's scrcpy server is spawned — ONE definition for opening, unfreezing and transport migration.

Those three paths each carried the same "phone mirror vs. app on its own virtual display" spawn block (with the mirror
bitrate floor as a magic number) and computed "is flex display on?" in three different ways.
"""
from __future__ import annotations

import contextlib
from typing import Any, Awaitable, Callable

from .mirror_packages import is_mirror_package
from .scrcpy_launcher import ScrcpySockets, serialize_start_app

# The phone mirror streams the full physical screen (display 0): below this it smears on scrolling text.
MIRROR_MIN_BITRATE = 24_000_000


def flex_display_enabled(project: Any, settings: Any) -> bool:
    """Flex (resizable) virtual displays: the user's project setting or the build-wide default. `project` may be None
    (settings DB unreadable) — then only the default counts."""
    return bool(project is not None and project.enable_flex_display) or bool(settings.ENABLE_FLEX_DISPLAY)


async def spawn_window_server(
    server: Any,
    *,
    package: str,
    project: Any,
    settings: Any,
    display_w: int,
    display_h: int,
    dpi: int | None,
    max_size: int,
    video_bit_rate: int,
    max_fps: int,
) -> None:
    """Spawns `server` for a window of `package`: the phone mirror captures display 0 (no virtual display, bitrate
    floor); any other app gets its own virtual display at `display_w`x`display_h`/`dpi`."""
    codec = project.video_codec if project is not None else "auto"
    if is_mirror_package(package):
        await server.spawn(
            new_display=None,
            max_size=0,
            video_bit_rate=max(video_bit_rate, MIRROR_MIN_BITRATE),
            max_fps=max_fps,
            control=True,
            send_frame_meta=True,
            video_codec=codec,
        )
    else:
        await server.spawn(
            new_display=f"{display_w}x{display_h}",
            dpi=dpi,
            max_size=max_size,
            video_bit_rate=video_bit_rate,
            max_fps=max_fps,
            control=True,
            send_frame_meta=True,
            flex_display=flex_display_enabled(project, settings),
            video_codec=codec,
        )


async def bring_up_server(
    server: Any, spawn: Callable[[], Awaitable[None]], *, start_app: str | None = None,
) -> ScrcpySockets:
    """push -> forward -> `spawn()` -> video+control sockets -> START_APP(`start_app`): the one bring-up sequence of
    every scrcpy server (open, unfreeze, transport migration, popout, the shared Workspace display). Any failure
    stops the half-started server before re-raising — it would otherwise hold a hardware encoder slot until the
    orphan reaper noticed it."""
    try:
        await server.push_server()
        await server.start_forward()
        await spawn()
        sockets = await server.connect_sockets(video=True, audio=False, control=True)
        if sockets.control is None:
            raise RuntimeError("scrcpy control socket missing after connect")
        if start_app:
            with contextlib.suppress(Exception):
                await sockets.control.send(serialize_start_app(start_app))
        return sockets
    except BaseException:
        with contextlib.suppress(Exception):
            await server.stop()
        raise
