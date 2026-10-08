"""windows/resize_gate.py — the per-window resize safety belt."""
import asyncio

import pytest

from app.windows.resize_gate import ResizeGate


class Clock:
    """A fake monotonic clock whose sleep() advances it (and yields, so other requests can arrive)."""

    def __init__(self):
        self.now = 100.0
        self.slept: list[float] = []

    def __call__(self):
        return self.now

    async def sleep(self, seconds):
        self.slept.append(round(seconds, 3))
        self.now += seconds
        await asyncio.sleep(0)


def gate(interval=0.3):
    clock = Clock()
    return ResizeGate(interval, clock=clock, sleep=clock.sleep), clock


async def run(g, log, name, work_s=0.0, clock=None):
    async with g.slot() as go:
        log.append((name, go))
        if go and work_s and clock is not None:
            clock.now += work_s  # the resize itself takes this long


async def test_a_calm_request_waits_zero():
    g, clock = gate()
    log = []
    await run(g, log, "a")
    assert log == [("a", True)] and clock.slept == []


async def test_the_interval_is_measured_from_the_previous_completion():
    g, clock = gate(0.3)
    log = []
    await run(g, log, "a", work_s=0.5, clock=clock)   # took 0.5 s; finished at t=100.5
    clock.now += 0.1                                   # next request 0.1 s after it ENDED
    await run(g, log, "b")
    assert clock.slept == [0.2]                        # waits the remaining 0.2 s of quiet, not 0
    clock.now += 1.0
    await run(g, log, "c")
    assert clock.slept == [0.2]                        # long after: no wait at all


async def test_a_burst_applies_only_the_newest_request():
    g, clock = gate(0.3)
    log = []
    await run(g, log, "first", work_s=0.05, clock=clock)
    # Four requests arrive while the window is still inside its interval.
    await asyncio.gather(*(run(g, log, f"r{i}") for i in range(4)))
    assert log[0] == ("first", True)
    assert [go for _, go in log[1:]] == [False, False, False, True]
    assert log[-1] == ("r3", True)


async def test_a_superseded_request_does_not_restart_the_interval():
    g, clock = gate(0.3)
    log = []
    await run(g, log, "a")
    await asyncio.gather(run(g, log, "b"), run(g, log, "c"))   # b superseded by c
    done_after_c = clock.now
    clock.now += 0.31
    await run(g, log, "d")
    assert ("b", False) in log and ("c", True) in log
    assert clock.now - done_after_c == pytest.approx(0.31)     # d did not wait: only c (granted) set the interval


async def test_a_failed_resize_still_starts_the_interval():
    g, clock = gate(0.3)
    with pytest.raises(RuntimeError):
        async with g.slot() as go:
            assert go
            raise RuntimeError("encoder died")
    await run(g, [], "next")
    assert clock.slept == [0.3]                        # the phone still gets its quiet after a failed reconfigure


async def test_zero_interval_never_waits_but_newest_still_wins():
    g, clock = gate(0.0)
    log = []

    async def slow(name):
        async with g.slot() as go:
            log.append((name, go))
            await asyncio.sleep(0)

    await asyncio.gather(slow("a"), slow("b"), slow("c"))
    assert clock.slept == []
    assert log[0] == ("a", True) and log[-1] == ("c", True) and ("b", False) in log
