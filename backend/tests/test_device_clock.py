"""The phone's clock in the backend's terms (app/device/device_clock.py): quick AND fresh pings win, old ones age out."""

from app.device.device_clock import DRIFT_PPM, WINDOW_NS, DeviceClockModel

MS = 1_000_000


def test_knows_nothing_before_the_first_ping():
    model = DeviceClockModel()
    assert model.estimate(0) is None
    assert model.newest_age_ns(0) is None


def test_a_ping_places_the_device_clock_half_way_through_its_round_trip():
    model = DeviceClockModel()
    # sent at 1000 ms, back at 1004 ms; the phone said 50 000 ms → at backend 1002 ms the phone read 50 000 ms
    assert model.add(1000 * MS, 1004 * MS, 50_000_000) is True
    device_us, err_ms = model.estimate(1004 * MS)
    assert device_us == 50_002_000                                       # 2 ms after the middle
    assert err_ms == 2.0                                                 # half the round trip, no age yet


def test_the_quickest_ping_wins_and_its_uncertainty_grows_with_age():
    model = DeviceClockModel()
    model.add(0, 10 * MS, 1_000)                                         # rtt 10
    model.add(100 * MS, 102 * MS, 101_000)                               # rtt 2 → the one used
    model.add(200 * MS, 230 * MS, 216_000)                               # rtt 30
    best = model.best(230 * MS)
    assert best.rtt_ns == 2 * MS
    later = model.estimate(10_102 * MS)[1]                               # 10 s on: drift is added to its error
    assert later == 1.0 + 10_000 * DRIFT_PPM / 1_000_000


def test_a_fresher_slightly_slower_ping_beats_an_old_quick_one():
    model = DeviceClockModel()
    model.add(0, 2 * MS, 1_000)                                          # rtt 2 at t=0
    model.add(15_000 * MS, 15_003 * MS, 15_001_500)                      # rtt 3, 15 s later
    assert model.best(15_003 * MS).at_ns == 15_003 * MS                  # 1 ms + 0.75 ms drift > 1.5 ms


def test_pings_older_than_the_window_age_out():
    model = DeviceClockModel()
    model.add(0, 2 * MS, 1_000)
    assert model.estimate(WINDOW_NS + 3 * MS) is None
    model.add(WINDOW_NS, WINDOW_NS + 8 * MS, 99)
    assert len(model._samples) == 1


def test_refuses_a_ping_that_cannot_be_right_and_reset_forgets():
    model = DeviceClockModel()
    assert model.add(10, 5, 1) is False                                  # came back before it was sent
    assert model.add(0, 5, None) is False                                # a jar without clock_us
    assert model.add(0, 5, "12") is False
    model.add(0, 2 * MS, 1_000)
    model.reset()
    assert model.estimate(2 * MS) is None
