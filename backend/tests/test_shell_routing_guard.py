"""Static guard: every device shell command goes through Adb.shell / Adb.shell_bytes — daemon first, adb as the fallback.

The rule only holds if nobody reaches around it, so this test reads the backend's source and fails when a module:

  * runs a shell on the phone through `Adb.run("shell", …)` or `Adb.exec_out(…)` (plain adb, the daemon never asked),
  * uses a low-level adb entry point (`_execute`, `_build`) from outside `device/adb.py`,
  * starts an adb process of its own, or
  * calls an adb-only entry point (`shell_direct`, `spawn_shell`, `spawn_logcat`) that is not on the list below.

Every list entry carries its reason. A new entry is a decision to review: "this command may not use the daemon, because …".
The lists are exact — an entry whose call no longer exists fails too, so the guard cannot rot into a blanket permission.
"""
import ast
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parent.parent / "app"
ADB_MODULE = "device/adb.py"

# attribute name -> {module (relative to app/): why it may call it}
ADB_ONLY_ENTRY_POINTS = {
    "shell_direct": {
        "device/device_daemon_client.py": "the daemon's own lifecycle: pgrep / pkill / spawn — it is not there yet, or it is what is being killed",
        "main.py": "pkill of a stale daemon after a jar update — the daemon would be killing its own shell",
        "telemetry/hub.py": "the fallback round-trip probe, which must time adb itself (not the daemon) when the daemon cannot be pinged",
    },
    "spawn_shell": {
        "windows/scrcpy_launcher.py": "hosts the scrcpy server for the lifetime of the session and streams its stdout — a long-lived process, not a command",
    },
    "spawn_logcat": {
        "device/notification_service.py": "adb's logcat stream — a long-lived stream, not a command",
    },
}
# Used only by adb.py itself.
LOW_LEVEL_ADB = {"_execute", "_build", "exec_out"}
# First arguments of `Adb.run(...)` that talk to the adb server / transport and never to a shell on the phone.
HOST_SIDE_RUN = {"devices", "get-state", "push", "forward", "connect", "pair", "disconnect", "tcpip"}
# First arguments that would execute something on the phone: those belong to Adb.shell / Adb.shell_bytes.
DEVICE_SIDE_RUN = {"shell", "exec-out", "exec-in", "logcat", "bugreport", "install", "uninstall"}


def _modules():
    for path in sorted(APP.rglob("*.py")):
        yield path.relative_to(APP).as_posix(), ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _method_calls(tree):
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            yield node


def _first_string_arg(call):
    if call.args and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str):
        return call.args[0].value
    return None


def bypasses(module, tree):
    """Calls in `module` that reach a device shell, or adb itself, without the daemon-first entry points."""
    if module == ADB_MODULE:
        return []
    found = []
    for call in _method_calls(tree):
        name = call.func.attr
        if name in LOW_LEVEL_ADB:
            found.append(f"{module}:{call.lineno} .{name}(…) is low-level adb — use Adb.shell / Adb.shell_bytes")
        elif name == "run" and _first_string_arg(call) in DEVICE_SIDE_RUN:
            found.append(f"{module}:{call.lineno} .run({_first_string_arg(call)!r}, …) runs on the phone — use Adb.shell / Adb.shell_bytes")
        elif name == "create_subprocess_exec":
            found.append(f"{module}:{call.lineno} starts a process of its own — adb processes belong to Adb")
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and node.attr in {"ADB_PATH", "adb_path"} and module not in {"config.py", "main.py"}:
            found.append(f"{module}:{node.lineno} reads the adb binary path — only Adb launches it")
    return found


def adb_only_calls(module, tree):
    """(entry point, line) for every call of an adb-only entry point in `module`."""
    if module == ADB_MODULE:
        return []
    return [(call.func.attr, call.lineno) for call in _method_calls(tree) if call.func.attr in ADB_ONLY_ENTRY_POINTS]


def _is_adb(receiver):
    """`adb`, `_adb`, `self._adb`, `ctx.adb` … — the receivers that are an Adb (not uvicorn, not some other `.run`)."""
    name = receiver.id if isinstance(receiver, ast.Name) else getattr(receiver, "attr", "")
    return name in {"adb", "_adb"}


def unclassified_run_commands(module, tree):
    return [
        f"{module}:{call.lineno} .run({_first_string_arg(call)!r}, …)"
        for call in _method_calls(tree)
        if call.func.attr == "run" and _is_adb(call.func.value) and module != ADB_MODULE
        and _first_string_arg(call) is not None and _first_string_arg(call) not in HOST_SIDE_RUN | DEVICE_SIDE_RUN
    ]


# ---------------------------------------------------------------- the real code


def test_nothing_reaches_adb_around_the_daemon_first_entry_points():
    offenders = [line for module, tree in _modules() for line in bypasses(module, tree)]
    assert not offenders, "\n".join(offenders)


def test_adb_only_entry_points_are_used_only_where_there_is_a_reason():
    used: dict[str, set[str]] = {name: set() for name in ADB_ONLY_ENTRY_POINTS}
    offenders = []
    for module, tree in _modules():
        for name, line in adb_only_calls(module, tree):
            used[name].add(module)
            if module not in ADB_ONLY_ENTRY_POINTS[name]:
                offenders.append(f"{module}:{line} .{name}(…) bypasses the daemon — add it to the list WITH a reason, or use Adb.shell")
    assert not offenders, "\n".join(offenders)

    stale = [f"{name}: {module}" for name, modules in ADB_ONLY_ENTRY_POINTS.items() for module in modules if module not in used[name]]
    assert not stale, "listed but no longer used (remove from the list): " + ", ".join(stale)


def test_every_adb_run_command_is_classified_as_host_side():
    unknown = [line for module, tree in _modules() for line in unclassified_run_commands(module, tree)]
    assert not unknown, "unclassified adb command (host side → HOST_SIDE_RUN; on the phone → Adb.shell):\n" + "\n".join(unknown)


# ---------------------------------------------------------------- the guard itself


@pytest.mark.parametrize(
    "source",
    [
        'await adb.run("shell", "id")',
        'await self._adb.run("exec-out", "sh", "-c", "id")',
        "await adb.exec_out('id')",
        "await adb._execute(['shell', 'id'], None, 1)",
        "await adb._build(['shell'], None)",
        'await asyncio.create_subprocess_exec("adb", "shell", "id")',
        "path = settings.ADB_PATH",
    ],
)
def test_the_guard_catches_every_bypass_it_exists_for(source):
    assert bypasses("windows/some_module.py", ast.parse(source.replace("await ", ""))), source


@pytest.mark.parametrize(
    "source",
    ['await adb.shell("id")', "await adb.shell_bytes('id')", 'await adb.run("forward", "tcp:1", "tcp:2")', 'await adb.run("devices", "-l")'],
)
def test_the_guard_leaves_the_sanctioned_paths_alone(source):
    assert bypasses("windows/some_module.py", ast.parse(source.replace("await ", ""))) == []


def test_adb_py_itself_is_exempt_and_the_other_entry_points_are_still_flagged_elsewhere():
    tree = ast.parse("adb.exec_out('x'); adb.shell_direct('y')")
    assert bypasses(ADB_MODULE, tree) == [] and adb_only_calls(ADB_MODULE, tree) == []
    assert adb_only_calls("windows/some_module.py", tree) == [("shell_direct", 1)]


def test_an_unknown_adb_subcommand_must_be_classified():
    flagged = unclassified_run_commands("device/new.py", ast.parse("adb.run('reboot')"))
    assert flagged and "reboot" in flagged[0]
    assert unclassified_run_commands("device/new.py", ast.parse("uvicorn.run('app.main:app')")) == [], "other .run() calls are not adb's"
