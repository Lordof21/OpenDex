"""Mutual authentication of the host <-> on-device daemon control socket.

The daemon's socket is reached through ``adb forward tcp:<port> localabstract:opendex_daemon``. adbd — uid ``shell`` —
makes that connection, so the daemon's own peer-uid check passes for ANY program on this PC. In particular a web page
can ``fetch("http://127.0.0.1:28100", {method: "POST", body: "<daemon commands>"})``: the body is read by a line-based
service as commands (a cross-protocol attack). Since the daemon runs shell commands for the backend, that must not
work: the daemon is started with a per-install secret, and a client has to prove it holds it before a single command
is read.

The converse matters just as much. The backend sends the daemon commands that can carry a secret (a Wi-Fi passphrase),
and whatever listens on 127.0.0.1:28100 would receive them. A program that got to the port first (another user on a
shared machine, malware) must not be taken for the daemon. So the proof runs both ways, and neither side ever sends the
secret — each proves it holds it with an HMAC-SHA256 over a message that names its role and both fresh nonces:

    daemon  -> client   {"type":"auth_required","nonce":Ns}
    client  -> daemon   auth HMAC(key, "client|"+Ns) Nc
    daemon  -> client   {"type":"greeting", ..., "auth_proof": HMAC(key, "server|"+Nc+"|"+Ns)}

The role prefixes keep either side's answer from being replayed as the other's; the client's fresh ``Nc`` makes a
recorded greeting worthless on the next connection. The client refuses to use a daemon whose greeting does not carry the
right proof (``DeviceDaemonClient``). Java twin: ``DaemonAuth.java`` (agreement is tested across the two languages,
``test_java_pure_classes.py``).

The key lives in its own 0600 file next to the API token (never the API token itself: that one is handed to the
browser UI; this one never leaves the backend and the phone). It is hex, so it is shell-safe by construction. It reaches
the daemon on the spawn command's STDIN — not in any argv, on the PC or on the phone (``DeviceDaemonClient``).
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
from pathlib import Path

from ..storage.private_file import write_private

log = logging.getLogger(__name__)

TOKEN_ENV = "OPENDEX_DAEMON_TOKEN"
TOKEN_BYTES = 32
# 64 lower-case hex digits. Also what makes the token safe to interpolate into a shell command line.
_TOKEN_RE = re.compile(r"[0-9a-f]{64}")


def new_token() -> str:
    return secrets.token_hex(TOKEN_BYTES)


def is_valid_token(token: object) -> bool:
    return isinstance(token, str) and _TOKEN_RE.fullmatch(token) is not None


def load_or_create_token(path: Path) -> str:
    """The per-install daemon secret: the file's token when it holds a valid one, else a new one written 0600. A file
    that is damaged or hand-edited into something unsafe for a command line is replaced, not trusted."""
    path = Path(path).expanduser()
    try:
        existing = path.read_text(encoding="utf-8").strip()
    except OSError:
        existing = ""
    if is_valid_token(existing):
        return existing
    token = new_token()
    write_private(path, token)
    log.info("🔐 [Daemon] Yeni daemon anahtarı üretildi → %s", path)
    return token


# A nonce as both sides generate it: lower-case hex. Fixed alphabet = it can never carry the "|" or " " the messages use.
_NONCE_RE = re.compile(r"[0-9a-f]{16,64}")


def new_nonce() -> str:
    return secrets.token_hex(16)


def is_nonce(value: object) -> bool:
    return isinstance(value, str) and _NONCE_RE.fullmatch(value) is not None


def _hmac_hex(token: str, message: str) -> str:
    return hmac.new(token.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()


def client_answer(token: str, server_nonce: str) -> str:
    """hex(HMAC-SHA256(key, "client|" + Ns)) — what the daemon expects after ``auth ``."""
    return _hmac_hex(token, f"client|{server_nonce}")


def server_proof(token: str, client_nonce: str, server_nonce: str) -> str:
    """hex(HMAC-SHA256(key, "server|" + Nc + "|" + Ns)) — what only a holder of the key can put in the greeting."""
    return _hmac_hex(token, f"server|{client_nonce}|{server_nonce}")


def answer_line(token: str, server_nonce: str, client_nonce: str) -> str:
    """The one line a client sends to answer the daemon's challenge, carrying its own nonce (no line break)."""
    return f"auth {client_answer(token, server_nonce)} {client_nonce}"


def proof_is_valid(token: str, client_nonce: str, server_nonce: str, proof: object) -> bool:
    """True when `proof` is the daemon's proof for this handshake (constant-time comparison)."""
    return isinstance(proof, str) and hmac.compare_digest(proof, server_proof(token, client_nonce, server_nonce))
