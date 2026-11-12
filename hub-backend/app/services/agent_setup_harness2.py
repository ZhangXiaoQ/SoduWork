"""Enable and verify the bundled, independent Harness² runtime."""
from __future__ import annotations

from threading import RLock

from . import harness2_lifecycle, harness2_runtime

_ACTION_LOCK = RLock()


def _check_versions() -> str:
    return ("Harness² 核心及独立执行器 " + harness2_runtime.version()
            + "（随 SoduWork 升级），无需安装其他底座。" + harness2_lifecycle.disabled_issue())


def run(jid: str, action: str) -> None:
    # Import the job helpers only after agent_setup has initialized its registry.
    from .agent_setup import _done

    try:
        with _ACTION_LOCK:
            if action == "uninstall":
                harness2_lifecycle.disable()
                _done(jid, True, "Google Harness² 已停用；内置文件已保留，点「装上」可重新启用。")
                return
            if not harness2_runtime.is_bundled():
                _done(jid, False, "Harness² 内置文件不完整，请修复或升级 SoduWork。")
                return
            if action == "check":
                _done(jid, True, _check_versions())
                return
            issue = harness2_runtime.runtime_issue(probe=True, ignore_disabled=True)
            if issue:
                _done(jid, False, issue)
                return
            harness2_lifecycle.enable()
            _done(jid, True, "Google Harness² 内置核心及独立执行器已就绪；点「测一下」确认模型连接。")
    except Exception as exc:  # noqa: BLE001 - always settle the setup job
        _done(jid, False, "Harness² 操作未完成：" + str(exc)[:220])
