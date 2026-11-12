"""Runner-local enablement for the bundled Harness² core.

Disabling this runtime retains bundled code and does not modify other runtimes.
"""
from __future__ import annotations

import os
from pathlib import Path
import tempfile


def _marker() -> Path:
    from .local_base import _data_root

    return Path(_data_root()) / "agents" / "harness2" / "disabled.json"


def disabled_issue() -> str:
    if _marker().exists():
        return "Google Harness² 已停用；点「装上」重新启用。"
    return ""


def disable() -> None:
    marker = _marker()
    marker.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=marker.parent, prefix=".disabled-", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write('{"schemaVersion":1,"disabled":true}\n')
        os.replace(temporary, marker)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def enable() -> None:
    _marker().unlink(missing_ok=True)
