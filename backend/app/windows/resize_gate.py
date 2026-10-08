"""Per-window resize safety belt.

Every real resize makes the phone do system-wide work: a display configuration change, a Shell transition, an encoder
reset, the app's relayout (sometimes a relaunch). A misbehaving client, a feedback loop or a user shaking a window
must not turn that into dozens of reconfigurations a second — and requests that queue up behind one another must not
each reach the phone after a newer one has already made them pointless.

The rule — "newest wins, at least ``interval_s`` of quiet between two real resizes":

* Idle (the previous resize ended ``interval_s`` or longer ago): the request passes with ZERO wait. A calm, single
  resize — the normal case — never pays for the belt.
* Busy: it waits until the interval since the previous COMPLETION has elapsed. If a newer request for the same window
  arrived meanwhile, this one is superseded and never reaches the phone; only the newest size is applied.
* The interval is measured from the previous resize's completion (success or failure), not its start: the phone gets
  a full interval of quiet after it finished reconfiguring.

The gate holds nothing global: the caller takes the window-manager lock only after ``slot()`` granted the turn, so a
window waiting out its interval never delays any other window (§3-B5.1).

This is the backend half of B1. The other half — scrcpy's own unconditional 300 ms debounce turned into the same
leading-edge rule — lives in the patched server (``backend/scrcpy/patches``). Because this gate measures from
COMPLETION and the server from its last TRIGGER, a request this gate lets through always finds the server idle.
"""
from __future__ import annotations

import asyncio
import contextlib
import time
from typing import AsyncIterator, Awaitable, Callable


class ResizeGate:
    def __init__(
        self,
        interval_s: float,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._interval = max(0.0, float(interval_s))
        self._clock = clock
        self._sleep = sleep
        self._turn = asyncio.Lock()          # one resize of this window at a time
        self._last_done = float("-inf")      # when the previous granted resize COMPLETED
        self._seq = 0                        # bumped by every request: the newest one is the only one worth doing

    @contextlib.asynccontextmanager
    async def slot(self) -> AsyncIterator[bool]:
        """``async with gate.slot() as go``: ``go`` is True when this request should run now, False when a newer
        request superseded it while it waited (the caller answers "superseded" and touches nothing)."""
        self._seq += 1
        mine = self._seq
        async with self._turn:
            if mine == self._seq:
                wait = self._last_done + self._interval - self._clock()
                if wait > 0:
                    await self._sleep(wait)
            if mine != self._seq:
                yield False                  # superseded: the interval is NOT restarted — nothing reached the phone
                return
            try:
                yield True
            finally:
                self._last_done = self._clock()
