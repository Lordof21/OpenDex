"""device/proc_cpu.py: per-app CPU from /proc deltas — the parser, the identity rules and the arithmetic."""
import pytest

from app.device import proc_cpu
from app.device.proc_cpu import package_of, parse_probe, probe_script, usage_between

PKG = "com.example.video"


def stat_line(pid: int, name: str, utime: int, stime: int, start: int) -> str:
    """A /proc/<pid>/stat line: state is field 3, utime 14, stime 15, starttime 22."""
    after_name = ["S", "1", "1", "0", "0", "0", "0", "0", "0", "0", "0", str(utime), str(stime), "0", "0", "20", "0", "9", "0", str(start), "0"]
    return f"{pid} ({name}) " + " ".join(after_name)


def probe(total: int, idle: int, procs: list[tuple[int, str, int, int, int]] | None = None, cores: int = 4) -> str:
    """The script's output: aggregate + per-core cpu lines, then `P pid name` + stat line per process."""
    lines = [f"cpu  {total - idle - 20} 0 20 {idle - 5} 5 0 0 0 0 0"]
    lines += [f"cpu{i} 1 0 1 1 0 0 0 0 0 0" for i in range(cores)]
    for pid, name, utime, stime, start in procs or []:
        lines += [f"P {pid} {name}", stat_line(pid, name, utime, stime, start)]
    return "\n".join(lines) + "\n"


def snap(total, idle, procs=None, cores=4, packages=(PKG,)):
    parsed = parse_probe(probe(total, idle, procs, cores), list(packages))
    assert parsed is not None
    return parsed


# ---------------------------------------------------------------- parsing


def test_the_aggregate_line_gives_total_and_idle_and_the_core_lines_give_the_core_count():
    s = snap(1000, 400, cores=8)
    assert (s.total, s.idle, s.cores) == (1000, 400, 8)


def test_guest_time_is_not_counted_twice():
    """`guest` and `guest_nice` are already inside user/nice: only the first eight fields add up."""
    raw = "cpu  100 10 50 800 20 5 5 10 999 999\ncpu0 1 1 1 1 1 1 1 1 1 1\n"
    s = parse_probe(raw, [])
    assert s is not None and s.total == 100 + 10 + 50 + 800 + 20 + 5 + 5 + 10 and s.idle == 820


def test_a_process_name_with_spaces_and_parentheses_does_not_shift_the_fields():
    raw = probe(1000, 400).replace("\n", "\nP 77 com.example.video\n77 (weird (name) x) S " + " ".join(
        ["1"] * 10 + ["30", "12"] + ["0"] * 6 + ["4242", "0"]) + "\n", 1)
    s = parse_probe(raw, [PKG])
    assert s is not None and s.procs == {(77, 4242): (PKG, 42)}


@pytest.mark.parametrize("raw", [None, "", "no cpu here\n", "cpu  garbage\n", "cpu  0 0 0 0 0 0 0 0\n"])
def test_no_readable_proc_stat_means_no_snapshot(raw):
    assert parse_probe(raw, [PKG]) is None


def test_a_truncated_stat_line_is_skipped_not_fatal():
    raw = probe(1000, 400) + f"P 5 {PKG}\n5 (x) S 1 2\n"
    s = parse_probe(raw, [PKG])
    assert s is not None and s.procs == {}


def test_only_the_package_itself_and_its_colon_processes_belong_to_it():
    assert package_of("com.example.video", [PKG]) == PKG
    assert package_of("com.example.video:player", [PKG]) == PKG
    assert package_of("com.example.videoplus", [PKG]) is None  # a different package that merely shares a prefix
    assert package_of("com.example", [PKG]) is None


def test_extra_processes_of_an_app_are_attributed_to_it():
    s = snap(1000, 400, [(10, PKG, 5, 5, 100), (11, f"{PKG}:player", 20, 0, 150)])
    assert {v[0] for v in s.procs.values()} == {PKG} and sum(v[1] for v in s.procs.values()) == 30


# ---------------------------------------------------------------- the probe script


def test_probe_script_lists_every_valid_package_and_nothing_else():
    script = probe_script([PKG, "org.other.app", "bad name; reboot", "$(id)", PKG])
    assert f"{PKG}|{PKG}:*" in script and "org.other.app|org.other.app:*" in script
    assert "reboot" not in script and "$(id)" not in script
    assert script.count(f"{PKG}|") == 1  # de-duplicated


def test_probe_script_without_packages_still_reads_the_device_counters():
    script = probe_script([])
    assert "grep '^cpu' /proc/stat" in script and "__none__" in script


# ---------------------------------------------------------------- arithmetic


def test_cpu_is_the_apps_share_of_all_cores_jiffies():
    base = snap(10_000, 6_000, [(10, PKG, 100, 50, 7)])
    cur = snap(10_400, 6_200, [(10, PKG, 140, 70, 7)])  # the app used 60 of the 400 jiffies all cores spent

    usage = usage_between(base, cur)

    assert usage is not None
    assert usage.apps[PKG].cpu_pct == 15.0 and usage.apps[PKG].processes == 1
    assert usage.device_pct == 50.0  # 200 of 400 jiffies were busy
    assert usage.cores == 4


def test_processes_of_one_app_add_up():
    base = snap(10_000, 6_000, [(10, PKG, 100, 0, 7), (11, f"{PKG}:svc", 10, 0, 9)])
    cur = snap(10_400, 6_200, [(10, PKG, 120, 0, 7), (11, f"{PKG}:svc", 30, 0, 9)])
    assert usage_between(base, cur).apps[PKG].cpu_pct == 10.0  # (20 + 20) / 400


def test_a_process_born_inside_the_interval_has_no_baseline_yet():
    base = snap(10_000, 6_000, [(10, PKG, 100, 0, 7)])
    cur = snap(10_400, 6_200, [(10, PKG, 110, 0, 7), (12, f"{PKG}:new", 9_999, 0, 8_000)])
    usage = usage_between(base, cur)
    assert usage.apps[PKG].cpu_pct == 2.5 and usage.apps[PKG].processes == 1  # the newborn's lifetime is not "this second"


def test_a_recycled_pid_is_not_the_old_process():
    base = snap(10_000, 6_000, [(10, PKG, 5_000, 0, 7)])
    cur = snap(10_400, 6_200, [(10, PKG, 3, 0, 9_000)])  # same pid, different start time
    assert usage_between(base, cur).apps == {}


def test_an_app_that_was_not_running_in_the_baseline_is_unknown_not_zero():
    base = snap(10_000, 6_000, [])
    cur = snap(10_400, 6_200, [(10, PKG, 50, 0, 7)])
    assert PKG not in usage_between(base, cur).apps


def test_an_idle_app_is_zero_not_unknown():
    base = snap(10_000, 6_000, [(10, PKG, 100, 0, 7)])
    cur = snap(10_400, 6_200, [(10, PKG, 100, 0, 7)])
    assert usage_between(base, cur).apps[PKG].cpu_pct == 0.0


@pytest.mark.parametrize("cur_total", [10_000, 9_000])  # no progress / the phone rebooted between the reads
def test_counters_that_did_not_advance_give_no_usage(cur_total):
    base = snap(10_000, 6_000, [(10, PKG, 100, 0, 7)])
    assert usage_between(base, snap(cur_total, 6_000, [(10, PKG, 100, 0, 7)])) is None


def test_the_share_is_clamped_to_the_whole_device():
    base = snap(10_000, 6_000, [(10, PKG, 0, 0, 7)])
    cur = snap(10_100, 6_050, [(10, PKG, 500, 0, 7)])  # a sampling skew can make the app's delta exceed the total's
    assert usage_between(base, cur).apps[PKG].cpu_pct == 100.0


def test_module_exposes_no_per_package_special_cases():
    """The measurement is package-agnostic: no names hard-coded anywhere in the module."""
    source = open(proc_cpu.__file__, encoding="utf-8").read()
    assert "youtube" not in source.lower() and "chrome" not in source.lower()
