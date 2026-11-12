"""Immutable, bounded conversation payload storage on execution endpoints.

The authenticated Hub transport supplies the namespace. Neither file paths nor
execution credentials are accepted. A seal receipt follows a FULL SQLite commit.
"""
from __future__ import annotations

import base64
import hashlib
import os
import re
import sqlite3
import threading
from contextlib import contextmanager

CHUNK = 256 * 1024
MAX_OBJECT = 128 * 1024 * 1024
DEFAULT_QUOTA = 4 * 1024 * 1024 * 1024


def _journal_mode():
    # Older Python bundles contain SQLite's WAL-reset race. Rollback journals
    # retain FULL durability across multiple endpoint readers/writers until the
    # bundled engine includes the upstream fix or an official backport.
    version = sqlite3.sqlite_version_info
    fixed = (version >= (3, 51, 3) or
             (version[:2] == (3, 50) and version >= (3, 50, 7)) or
             (version[:2] == (3, 44) and version >= (3, 44, 6)))
    return "WAL" if fixed else "DELETE"


class Store:
    def __init__(self, root: str, *, quota: int | None = None):
        if quota is None:
            configured = os.environ.get("SODUWORK_CONVERSATION_CONTENT_QUOTA_MIB", "4096")
            if not re.fullmatch(r"[0-9]{1,8}", configured) or not 1 <= int(configured) <= 16 * 1024 * 1024:
                raise ValueError("SODUWORK_CONVERSATION_CONTENT_QUOTA_MIB must be between 1 and 16777216")
            quota = int(configured) * 1024 * 1024
        os.makedirs(root, exist_ok=True)
        self.file = os.path.join(root, "contents.sqlite")
        if os.path.islink(root) or os.path.islink(self.file):
            raise ValueError("Conversation storage cannot use links")
        self.quota = quota
        self.lock = threading.Lock()
        with self._connect() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version not in (0, 1):
                raise ValueError("Unsupported conversation storage version")
            mode = _journal_mode()
            if db.execute("PRAGMA journal_mode=" + mode).fetchone()[0].upper() != mode:
                raise ValueError("Conversation storage journal mode is unavailable")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS objects (
                    scope TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL,
                    sealed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,digest));
                CREATE TABLE IF NOT EXISTS chunks (
                    scope TEXT NOT NULL, digest TEXT NOT NULL, offset INTEGER NOT NULL,
                    body BLOB NOT NULL, PRIMARY KEY(scope,digest,offset),
                    FOREIGN KEY(scope,digest) REFERENCES objects(scope,digest));
                CREATE TABLE IF NOT EXISTS quota (id INTEGER PRIMARY KEY, bytes INTEGER NOT NULL);
                INSERT OR IGNORE INTO quota VALUES(1,0);
                PRAGMA user_version=1;
            """)

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.file, timeout=10)
        try:
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA foreign_keys=ON")
            yield db
        finally:
            db.close()

    @staticmethod
    def _identity(request):
        scope, digest = request.get("scope"), request.get("sha256")
        if (not isinstance(scope, str) or not re.fullmatch(r"[a-f0-9]{64}", scope)
                or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
            raise ValueError("Invalid conversation storage identity")
        return scope, digest

    def handle(self, request: dict) -> dict:
        scope, digest = self._identity(request)
        op = request.get("op")
        with self.lock, self._connect() as db:
            db.execute("BEGIN" if op in {"content.read", "content.status"} else "BEGIN IMMEDIATE")
            row = db.execute("SELECT size,sealed FROM objects WHERE scope=? AND digest=?", (scope, digest)).fetchone()
            if op == "content.status":
                result = {"durable": bool(row and row[1]), "size": row[0] if row else 0,
                          "sha256": digest, "scope": scope}
            elif op == "content.put":
                size, offset = request.get("size"), request.get("offset")
                if (type(size) is not int or not 0 <= size <= MAX_OBJECT or
                        type(offset) is not int or offset < 0 or offset % CHUNK):
                    raise ValueError("Invalid conversation chunk range")
                encoded = request.get("b64")
                if not isinstance(encoded, str) or len(encoded) > (CHUNK + 2) // 3 * 4:
                    raise ValueError("Conversation chunk exceeds limit")
                body = base64.b64decode(encoded, validate=True)
                if len(body) != min(CHUNK, max(0, size - offset)) or offset > size:
                    raise ValueError("Incomplete conversation chunk")
                if row and row[0] != size:
                    raise ValueError("Conversation size changed")
                if not row:
                    used = db.execute("SELECT bytes FROM quota WHERE id=1").fetchone()[0]
                    if used + size > self.quota:
                        raise ValueError("Conversation storage quota reached")
                    db.execute("INSERT INTO objects(scope,digest,size) VALUES(?,?,?)", (scope, digest, size))
                    db.execute("UPDATE quota SET bytes=bytes+? WHERE id=1", (size,))
                old = db.execute("SELECT body FROM chunks WHERE scope=? AND digest=? AND offset=?", (scope, digest, offset)).fetchone()
                if old and old[0] != body:
                    raise ValueError("Conversation retry content changed")
                if not old:
                    if row and row[1]:
                        raise ValueError("Sealed conversation cannot be changed")
                    db.execute("INSERT INTO chunks VALUES(?,?,?,?)", (scope, digest, offset, body))
                result = {"offset": offset, "size": len(body)}
            elif op == "content.seal":
                if not row:
                    raise ValueError("Conversation payload is missing")
                hasher, total = hashlib.sha256(), 0
                for offset, body in db.execute("SELECT offset,body FROM chunks WHERE scope=? AND digest=? ORDER BY offset", (scope, digest)):
                    if offset != total:
                        raise ValueError("Conversation payload has a gap")
                    hasher.update(body)
                    total += len(body)
                if total != row[0] or hasher.hexdigest() != digest:
                    raise ValueError("Conversation payload checksum mismatch")
                db.execute("UPDATE objects SET sealed=1 WHERE scope=? AND digest=?", (scope, digest))
                result = {"durable": True, "size": total, "sha256": digest, "scope": scope}
            elif op == "content.read":
                offset = request.get("offset", 0)
                if type(offset) is not int or offset < 0 or offset % CHUNK:
                    raise ValueError("Invalid conversation cursor")
                if not row or not row[1]:
                    raise ValueError("Conversation payload is not durably available")
                part = db.execute("SELECT body FROM chunks WHERE scope=? AND digest=? AND offset=?", (scope, digest, offset)).fetchone()
                if not part:
                    raise ValueError("Conversation payload page is missing")
                result = {"offset": offset, "b64": base64.b64encode(part[0]).decode("ascii"),
                          "size": row[0], "sha256": digest, "scope": scope}
            else:
                raise ValueError("Unsupported conversation storage operation")
            db.commit()
            return {"ok": True, "data": result}
