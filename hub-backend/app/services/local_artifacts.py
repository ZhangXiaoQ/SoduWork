"""Per-turn local file selection, workspace confinement and complete ZIP delivery.

This module owns filesystem rules only. The adapter retains run mutation/locks
and supplies its archive-directory resolver at each bundle call.
"""
from __future__ import annotations

import hashlib
import os
import uuid
import zipfile





_SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", "target",
    ".pytest_cache", ".ruff_cache", ".mypy_cache", ".cache", ".turbo", ".next",
    ".gradle", ".parcel-cache", "htmlcov", "coverage", ".idea", ".vscode",
}
_SKIP_NAMES = {"CACHEDIR.TAG", "lastfailed", "nodeids", "package-lock.json",
               ".gitignore", ".DS_Store", "Thumbs.db"}
_SKIP_PREFIX = (".soduwork-run-", "commit_msg", "prev_", "nav_shot", "nav_full")
# Application database files and sidecars are runtime state.
# Do not return them as deliverables.
# They also consume limited artifact slots.
# That could displace required stylesheets or screenshots.
# Filter them before applying output limits.
_SKIP_SUFFIX = (".pyc", ".pyo", ".log", ".tmp", ".swp", ".lock",
                ".db", ".db-shm", ".db-wal", ".sqlite", ".sqlite3")


def _is_noise(rel: str) -> bool:
    """Determine whether a file qualifies as a deliverable from its path and type, without
    inferring content.
    """
    base = os.path.basename(rel)
    parts = set(rel.replace("\\", "/").split("/")[:-1])
    if parts & _SKIP_DIRS:
        return True                                   # Exclude files inside cache directories.
    if base in _SKIP_NAMES:
        return True
    if base.startswith(_SKIP_PREFIX) or base.endswith(_SKIP_SUFFIX):
        return True
    return False


def _snapshot(ws: str) -> set:
    """Snapshot the workspace before execution so collection includes only files added or changed
    in this run.
    """
    got = set()
    try:
        for root, dirs, names in os.walk(ws):
            # Exclude tool-cache directories from workspace snapshots.
            # Running tests creates cache files unrelated to delivery.
            # Those files must not appear as task outputs.
            dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
            for n in names:
                p = os.path.join(root, n)
                try:
                    got.add((os.path.relpath(p, ws), os.path.getmtime(p)))
                except OSError:
                    pass
            if len(got) > 20000:
                break
    except Exception:  # noqa: BLE001
        pass
    return got



#   Static sites can contain dozens or hundreds of HTML, CSS, JavaScript, and asset files.
#   A ten-file limit can produce incomplete archives with missing stylesheets and images.
#   _is_noise already excludes node_modules, .git, dist, build, and cache directories.
_ART_CAP = 200
_BUNDLE_PREFIX = "@bundle/"
_BUNDLE_MAX_BYTES = 512 * 1024 * 1024


def _fresh_entries(run: dict) -> list[tuple[str, float]]:
    """Return the complete stable-sorted set of new or changed files without truncation here."""
    now = _snapshot(run["ws"])
    fresh = [(rel, m) for rel, m in (now - (run.get("seen") or set())) if not _is_noise(rel)]
    fresh.sort(key=lambda x: (-(x[1] or 0), x[0]))
    return fresh




def _safe_work_file(run: dict, rel: str) -> str:
    """Resolve a real file inside the execution workspace, rejecting symlinks that escape it."""
    root = os.path.realpath(str(run.get("ws") or ""))
    path = os.path.realpath(os.path.join(root, str(rel or "")))
    try:
        inside = os.path.commonpath([root, path]) == root
    except ValueError:
        inside = False
    return path if inside and os.path.isfile(path) else ""


def _bundle_artifact(run: dict, entries: list[tuple[str, float]], *,
                     store_dir, max_bytes: int = _BUNDLE_MAX_BYTES) -> dict | None:
    """Bundle more than two final outputs, retaining loose files for preview."""
    from . import declared_outputs, delivery_manifest
    declared = {rel.replace("\\", "/") for rel, _stamp in declared_outputs.changed_entries(run)}
    entries = [(rel, stamp) for rel, stamp in entries
               if rel.replace("\\", "/") in declared or delivery_manifest.classify_name(rel) != "evidence"]
    final_count = sum(rel.replace("\\", "/") in declared or
                      delivery_manifest.classify_name(rel) == "primary"
                      for rel, _stamp in entries)
    # Dependency files remain in a needed archive but do not inflate output count.
    # Keep the overflow transport archive so large sites never lose dependencies.
    if final_count <= 2 and len(entries) <= _ART_CAP:
        return None
    safe = []
    total = 0
    sig = hashlib.sha256()
    for rel, mtime in entries:
        path = _safe_work_file(run, rel)
        if not path:
            continue
        size = os.path.getsize(path)
        total += size
        if total > max_bytes:
            return None
        name = _rel_name(rel)
        safe.append((name, path))
        sig.update((name + "\0" + str(size) + "\0" + str(mtime) + "\n").encode("utf-8"))
    if len(safe) != len(entries):
        return None
    short = sig.hexdigest()[:10]
    filename = "完整产出-%s.zip" % short
    folder = os.path.join(store_dir(str(run.get("ref") or "")), "bundles")
    path = os.path.join(folder, filename)
    if not os.path.isfile(path):
        os.makedirs(folder, exist_ok=True)
        tmp = path + ".tmp-" + uuid.uuid4().hex[:8]
        try:
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
                for name, source in safe:
                    zf.write(source, name)
            os.replace(tmp, path)
        finally:
            try:
                if os.path.isfile(tmp):
                    os.remove(tmp)
            except OSError:
                pass
    return {"id": _BUNDLE_PREFIX + filename, "filename": filename,
            "files": len(safe), "size": os.path.getsize(path)}


def _rel_name(rel: str) -> str:
    """Technical contract for  rel name."""
    s = str(rel or "").replace("\\", "/").lstrip("/")
    parts = [p for p in s.split("/") if p not in ("", ".", "..")]
    return "/".join(parts)[:200] or "文件"
