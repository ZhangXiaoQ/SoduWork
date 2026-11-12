"""Stable provider-independent execution identity. Freeze routing facts at dispatch and add
initially unknown session fields later. Whitelist display and audit fields; exclude model keys,
Git credentials, and local configuration.
"""
from __future__ import annotations

from datetime import datetime, timezone


SCHEMA_VERSION = 1
_LIMITS = {
    "runnerId": 80, "runnerClientId": 64, "runnerVersion": 40, "host": 100,
    "agentCli": 60, "agentName": 100, "agentVersion": 60, "agentSessionId": 180,
    "model": 160, "assigneeId": 180, "assigneeName": 120,
    "selectionSource": 40, "selectionReason": 240,
    "workflowRunId": 36, "nodeRunId": 36, "frozenAt": 64,
}


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _base(value: dict | None = None) -> dict:
    source = dict(value or {})
    out = {"schemaVersion": SCHEMA_VERSION}
    for key, limit in _LIMITS.items():
        text = _text(source.get(key), limit)
        if text or (key == "runnerClientId" and source.get(key) is not None):
            out[key] = text
    return out


def from_dispatch(dispatch: dict | None, *, workflow_run_id: str = "",
                  node_run_id: str = "", current: dict | None = None) -> dict:
    """Freeze facts known at dispatch time; existing frozen facts win."""
    data = dict(dispatch or {})
    selection = dict(data.get("selection") or {})
    candidate = {
        "runnerId": data.get("runnerId"),
        "runnerClientId": data.get("runnerClientId"),
        "runnerVersion": data.get("runnerVersion"),
        "host": data.get("host"),
        "agentCli": data.get("agentCli") or data.get("assigneeCli"),
        "agentName": data.get("agentCliName") or data.get("assigneeName"),
        "agentVersion": data.get("agentCliVersion"),
        "agentSessionId": data.get("agentSessionId"),
        "model": data.get("model"),
        "assigneeId": data.get("assigneeId"),
        "assigneeName": data.get("assigneeName"),
        "selectionSource": selection.get("source"),
        "selectionReason": selection.get("reason"),
        "workflowRunId": workflow_run_id,
        "nodeRunId": node_run_id,
        "frozenAt": datetime.now(timezone.utc).isoformat(),
    }
    frozen = _base(current)
    incoming = _base(candidate)
    for key, value in incoming.items():
        if key != "schemaVersion" and key not in frozen:
            frozen[key] = value
    return frozen


def from_snapshot(current: dict | None, snapshot: dict | None, runner=None) -> dict:
    """Fill runtime facts that can only become known after the CLI starts."""
    snap = dict(snapshot or {})
    supplied = dict(snap.get("executionIdentity") or {})
    supplied.update({
        "runnerId": getattr(runner, "id", ""),
        "runnerClientId": getattr(runner, "client_id", ""),
        "runnerVersion": snap.get("runnerVersion") or getattr(runner, "version", ""),
        "host": getattr(runner, "host", ""),
        "agentCli": snap.get("cli") or snap.get("engine"),
        "agentName": snap.get("cliName"),
        "agentVersion": snap.get("cliVersion"),
        "agentSessionId": snap.get("cliSessionId") or snap.get("cliSid"),
        "model": snap.get("model"),
    })
    out = _base(current)
    clean = _base(supplied)
    # Route/model are frozen once known. CLI session id is the one legitimate late-bound fact.
    for key, value in clean.items():
        if key != "schemaVersion" and (key not in out or key == "agentSessionId"):
            out[key] = value
    return out
