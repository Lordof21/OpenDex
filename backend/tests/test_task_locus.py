"""task_locus.py — üç konum, çakışma kuralı ve WindowState.locus türetmesi."""
from __future__ import annotations

import pytest

from app.events import Event
from app.schemas import WindowState
from app.windows.task_locus import home_locus_of, locus_of


@pytest.mark.parametrize(
    "workspace_id, handoff, expected",
    [
        (None, False, "desktop"),
        ("eco", False, "workspace"),
        (None, True, "phone"),
        ("eco", True, "phone"),      # park edilmiş Workspace üyesi: fiziksel konum kazanır
    ],
)
def test_locus_truth_table(workspace_id, handoff, expected):
    assert locus_of(workspace_id, handoff) == expected


def test_reclaim_destination_is_where_the_task_was_born():
    assert home_locus_of("eco") == "workspace"
    assert home_locus_of(None) == "desktop"


def test_window_state_exposes_locus_and_survives_a_roundtrip():
    state = WindowState(window_id="w", package="p", width=1, height=1, workspace_id="eco")
    assert state.locus == "workspace"
    state.handoff_to_phone = True
    dumped = state.model_dump()
    assert dumped["locus"] == "phone"                       # frontend'e giden JSON'da var
    assert WindowState.model_validate(dumped).locus == "phone"   # layout restore fazla alanı yutar
    assert state.model_copy(deep=True).locus == "phone"


def test_new_event_type_is_registered():
    # EventType Literal'dir; kayıtsız tip ValidationError verir (bkz. events.py).
    Event(type="workspace_task_returned", payload={"window_id": "w"})
