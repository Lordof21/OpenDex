"""The phone's monotonic clock (the clock of the audio PTS) in the BACKEND's terms — first half of "İkisi" timing.

The DeX page has to know which of its own instants a device time is. Asking the phone straight through the page means one
probe = page → HTTP → backend → adb → daemon and back: the round trip is the SUM of both hops, and a probe is only as good as
its round trip is short (the device read its clock somewhere inside it; we assume the middle). So the two hops are measured
apart, each with its own quickest-probe filter:

  * here, backend ↔ daemon: a ping over the adb socket, timed with ``time.perf_counter_ns`` (QueryPerformanceCounter on
    Windows — ``time.monotonic`` ticks in 15.6 ms there); refreshed in the background while the page keeps asking;
  * on the page, page ↔ backend: a localhost request answered at once with this model's estimate (media/deviceClock.js).

The best of each is better than the best of the sum (the two hops are rarely quick in the same probe), and the page and the
backend share one hardware counter, so the page's half never drifts. The phone's crystal does drift against the PC's
(tens of ppm): a sample's uncertainty grows with its age, so a slightly slower but fresher probe wins over an old quick one.
"""

from __future__ import annotations

from dataclasses import dataclass

#: How far two crystals drift apart, worst case we plan for: 50 ppm = 0.05 ms per second.
DRIFT_PPM = 50
#: A sample is used for this long at most (by then drift alone could cost ~1 ms).
WINDOW_NS = 20_000_000_000
MAX_SAMPLES = 24


@dataclass(frozen=True, slots=True)
class ClockSample:
    rtt_ns: int
    offset_ns: int          # device_ns − backend_ns at the probe's middle
    at_ns: int              # backend time the answer came back

    def uncertainty_ns(self, now_ns: int) -> float:
        """How far off this probe's offset can be now: half its round trip, plus the drift since it was taken."""
        return self.rtt_ns / 2 + max(0, now_ns - self.at_ns) * DRIFT_PPM / 1_000_000


class DeviceClockModel:
    """Backend clock (``perf_counter_ns``) ↔ device clock. Feed it pings (`add`), read it with `estimate`."""

    def __init__(self) -> None:
        self._samples: list[ClockSample] = []

    def add(self, sent_ns: int, received_ns: int, device_us: float | int | None) -> bool:
        """One ping: backend time when sent / when the answer came back, and the device clock the answer carried."""
        if device_us is None or not isinstance(device_us, (int, float)) or received_ns < sent_ns:
            return False
        middle = (sent_ns + received_ns) // 2
        self._samples.append(ClockSample(received_ns - sent_ns, int(device_us * 1000) - middle, received_ns))
        self._samples = [s for s in self._samples if received_ns - s.at_ns <= WINDOW_NS][-MAX_SAMPLES:]
        return True

    def best(self, now_ns: int) -> ClockSample | None:
        """The sample with the least uncertainty now (quick AND fresh); None when none is recent enough."""
        live = [s for s in self._samples if now_ns - s.at_ns <= WINDOW_NS]
        return min(live, key=lambda s: (s.uncertainty_ns(now_ns), -s.at_ns)) if live else None

    def estimate(self, now_ns: int) -> tuple[int, float] | None:
        """(device clock in µs at backend time `now_ns`, its uncertainty in ms), or None without a usable sample."""
        best = self.best(now_ns)
        if best is None:
            return None
        return (now_ns + best.offset_ns) // 1000, best.uncertainty_ns(now_ns) / 1_000_000

    def newest_age_ns(self, now_ns: int) -> int | None:
        return now_ns - self._samples[-1].at_ns if self._samples else None

    def reset(self) -> None:
        """A new daemon process (or phone): what we knew may belong to another clock."""
        self._samples = []
