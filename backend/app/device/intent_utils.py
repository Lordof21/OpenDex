"""Shared Android dumpsys-intent-string -> ``am start`` argument parsing.

Used by both ``deep_navigator.py`` (resolving a PendingIntent's real target
via ``dumpsys activity intents``) and ``notification_service.py`` (resolving
a notification's own intent string) — these had drifted into two
independent regex implementations of the same
``act=``/``dat=``/``typ=``/``cmp=``/``cat=``/``flg=`` parsing.
"""
from __future__ import annotations

import re
import shlex


def find_request_intent(intents_dump: str, record_id: str) -> str | None:
    """The `requestIntent=` line of `PendingIntentRecord{<record_id> …}` in `dumpsys activity intents` output — searched
    ONLY inside that record's own block (a DOTALL `.*?` used to run past it into the next record's intent)."""
    # Same line or any later line of THIS record — the tempered dot never crosses into the next record.
    pattern = r"PendingIntentRecord\{" + re.escape(record_id) + r"\b(?:(?!PendingIntentRecord\{).)*?requestIntent=([^\r\n]+)"
    m = re.search(pattern, intents_dump or "", re.DOTALL)
    return m.group(1).strip() if m else None


def parse_intent_args(intent_str: str, *, quote: str = '"') -> list[str]:
    """Converts an Android dumpsys request-intent string into ``am start`` argument tokens (join with a space to
    build the command).

    Every value is a SINGLE shell word (shlex.quote): the dump is written by the app that posted the notification, and a
    data URI or action such as ``x';reboot;'`` used to break out of the plain quotes and run on the phone as the shell
    user. ``quote`` is kept for the call sites' signatures; it no longer influences the (always safe) quoting.
    """
    del quote
    args: list[str] = []
    m_act = re.search(r"\bact=([^\s]+)", intent_str)
    if m_act:
        args.extend(["-a", shlex.quote(m_act.group(1))])

    m_dat = re.search(r"\bdat=([^\s]+)", intent_str)
    if m_dat:
        args.extend(["-d", shlex.quote(m_dat.group(1))])

    m_typ = re.search(r"\btyp=([^\s]+)", intent_str)
    if m_typ:
        args.extend(["-t", shlex.quote(m_typ.group(1))])

    m_cmp = re.search(r"\bcmp=([^\s]+)", intent_str)
    if m_cmp:
        args.extend(["-n", shlex.quote(m_cmp.group(1))])

    m_cat = re.search(r"\bcat=\[([^\]]+)\]", intent_str)
    if m_cat:
        for c in m_cat.group(1).split(","):
            c = c.strip()
            if c:
                args.extend(["-c", shlex.quote(c)])

    m_flg = re.search(r"\bflg=(0x[0-9a-fA-F]+|\d+)", intent_str)
    if m_flg:
        args.extend(["-f", m_flg.group(1)])
    else:
        # Default to FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TOP (0x14000000)
        args.extend(["-f", "0x14000000"])

    return args


def option_value(args_str: str, flag: str) -> str | None:
    """The (unquoted) value that follows ``flag`` in an `am start` argument string built by this module; None when the
    flag is absent or the string does not tokenise. Re-embed it with shlex.quote."""
    try:
        tokens = shlex.split(args_str or "")
    except ValueError:
        return None
    for i, tok in enumerate(tokens[:-1]):
        if tok == flag:
            return tokens[i + 1]
    return None
