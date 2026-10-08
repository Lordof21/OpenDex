"""The engine reports from sync code; the pump hands events to the (async) bus in order."""
import asyncio

import pytest

from app.fs.service import EventPump

pytestmark = pytest.mark.asyncio


class SlowBus:
    def __init__(self, delays):
        self.delays = delays
        self.seen = []

    async def emit(self, event, **payload):
        await asyncio.sleep(self.delays[payload["n"]])          # an early event that takes LONGER than the later ones
        self.seen.append((event, payload["n"]))


async def test_events_reach_the_bus_in_the_order_they_were_reported():
    bus = SlowBus({1: 0.05, 2: 0.01, 3: 0.0})
    pump = EventPump(bus)
    pump.start()
    for n in (1, 2, 3):
        pump.put("fs_transfer", {"n": n})
    for _ in range(100):
        if len(bus.seen) == 3:
            break
        await asyncio.sleep(0.01)
    await pump.stop()
    assert [n for _, n in bus.seen] == [1, 2, 3]                  # a progress update must never overtake the final state


async def test_a_failing_bus_does_not_stop_the_pump():
    class Flaky(SlowBus):
        async def emit(self, event, **payload):
            if payload["n"] == 1:
                raise RuntimeError("boom")
            await super().emit(event, **payload)

    bus = Flaky({1: 0, 2: 0})
    pump = EventPump(bus)
    pump.start()
    pump.put("fs_changed", {"n": 1})
    pump.put("fs_changed", {"n": 2})
    for _ in range(50):
        if bus.seen:
            break
        await asyncio.sleep(0.01)
    await pump.stop()
    assert bus.seen == [("fs_changed", 2)]
