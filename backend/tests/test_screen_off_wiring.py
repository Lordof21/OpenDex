"""`screen_off_while_mirroring` is wired into EVERY endpoint that starts the mirroring: opening an app window as well as opening one in the
Workspace. (The setting itself is tested in test_screen_off_setting.py; here it is the endpoint that has to ask for it.)"""
import types

import pytest

from app.api.v1.endpoints import windows as endpoint


class _Manager:
    def __init__(self, open_windows):
        self._open = open_windows

    def list_windows(self):
        return self._open

    async def open_window(self, package, **_):
        return {"window_id": "w1", "package": package}

    async def open_window_in_workspace(self, package):
        return {"window_id": "w1", "package": package}


def _ctx(open_windows):
    return types.SimpleNamespace(serial="SERIAL", window_manager=_Manager(open_windows))


@pytest.fixture
def asked(monkeypatch):
    """What each endpoint asked the screen-off setting: a list of `first_window` values."""
    calls: list[bool] = []
    monkeypatch.setattr(endpoint, "_schedule_screen_off", lambda ctx, first_window: calls.append(first_window))
    return calls


async def test_opening_the_first_app_window_asks_for_the_screen_to_go_off(asked):
    await endpoint.open_window(endpoint.OpenWindowRequest(package="com.a"), _ctx([]))
    assert asked == [True]


async def test_opening_another_app_window_does_not_ask_again(asked):
    await endpoint.open_window(endpoint.OpenWindowRequest(package="com.a"), _ctx(["w0"]))
    assert asked == [False]                                    # the user may have turned the screen on by hand since


async def test_the_workspace_window_asks_the_same_way(asked):
    await endpoint.open_workspace_window(endpoint.OpenWorkspaceWindowRequest(package="com.a"), _ctx([]))
    await endpoint.open_workspace_window(endpoint.OpenWorkspaceWindowRequest(package="com.a"), _ctx(["w0"]))
    assert asked == [True, False]
