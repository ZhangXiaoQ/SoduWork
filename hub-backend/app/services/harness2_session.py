"""Atomic native transcripts inside the existing Runner session archive."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import tempfile
import uuid

MAX_BYTES = 32 * 1024 * 1024


class Session:
    def __init__(self, root, cwd, session_id=""):
        self.root = Path(root).resolve() / "sessions"
        self.root.mkdir(parents=True, exist_ok=True)
        self.id = session_id or "h2_" + uuid.uuid4().hex
        if not re.fullmatch(r"h2_[a-f0-9]{32}", self.id):
            raise ValueError("This session belongs to the former executor; start a new Harness² conversation")
        self.path = self.root / (self.id + ".json")
        self.cwd = os.path.normcase(os.path.realpath(cwd))
        self.lock = open(self.root / (self.id + ".lock"), "a+b")
        try:
            self.lock.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.messages = []
            if session_id:
                if self.path.is_symlink() or self.path.stat().st_size > MAX_BYTES:
                    raise ValueError("Invalid Harness² session archive")
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if data.get("schema") != 1 or data.get("cwd") != self.cwd:
                    raise ValueError("Harness² session workspace does not match")
                self.messages = data["messages"]
                if not isinstance(self.messages, list):
                    raise ValueError("Invalid Harness² transcript")
                self.recover_interrupted()
        except BaseException:
            self.lock.close()
            raise

    def recover_interrupted(self):
        # Apply both after reopening an archive and after an interrupted turn in
        # the same peer. An uncertain side effect is never replayed implicitly.
        outstanding = {}
        for row in self.messages:
            for call in row.get("tool_calls") or []:
                outstanding[call["id"]] = call
            if row.get("role") == "tool":
                outstanding.pop(row.get("tool_call_id"), None)
        for call_id in outstanding:
            self.messages.append({"role": "tool", "tool_call_id": call_id,
                "content": "Interrupted before a durable result. Inspect the actual state; do not assume success or repeat a side effect."})

    def save(self):
        raw = json.dumps({"schema": 1, "cwd": self.cwd, "messages": self.messages},
                         ensure_ascii=False).encode("utf-8")
        if len(raw) > MAX_BYTES or len(self.messages) > 4000:
            raise ValueError("Harness² history limit reached; start a new conversation")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.root, prefix=".turn-", delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)

    def close(self):
        self.lock.close()
