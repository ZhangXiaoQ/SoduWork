"""Agent discovery, explicit installation/configuration and bounded live probes.

Installation metadata comes from the shared catalog. A version probe only proves
that an executable starts; model readiness is tested by a separate explicit job.
Background jobs preserve progress without blocking the HTTP connection.
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import threading
import time
import uuid

from .local_base import (
    _PROFILES, _WIN, _bundled_pi_cli_js, _bundled_pi_node,
    _command_argv, _data_root, _npm_root, _pi_cli_js,
)
from .acp_agents import runtime_issue as _acp_runtime_issue
from ..agent_catalog import install_specs
from . import dsh_runtime, managed_agents, agent_npm_runtime, agent_npm_network, harness2_runtime
from . import agent_native_install
from . import harness2_probe
from .agent_npm_runtime import node_env
from .agent_setup_runtime import (
    _short, _codex_native_name, _codex_native_spec, _codex_dependency_version,
    _codex_native_version, _codex_native_matches, _codex_native_binary,
)
from .cli_account_auth import probe as _account_auth_probe
from .agent_version_probe import probe as _cached_version_probe
from .agent_setup_probe import (
    _clean as _probe_console_text, _why_failed, probe_succeeded as _probe_succeeded,
)
from .agent_messages import decorate as _decorate_agent
from .claude_runtime import account_setup as _claude_account_setup

log = logging.getLogger("uvicorn.error")

# The probe marker must demonstrate an actual model response.
# Prompt echo alone must not satisfy the probe.
# Pi and OpenCode JSON output can echo the user's prompt.
# For example: {"type":"message_start","message":{"role":"user",...}}.
# An echoed prompt does not prove the model responded.
# Construct the expected answer by joining two separately supplied marker halves.
# Only an actual answer should contain the joined marker.
_TOK_A = "SODUWORK_"
_TOK_B = "AGENT_OK"
_TOKEN = _TOK_A + _TOK_B                    # Keep the complete expected marker absent from the prompt.
_PROMPT = (f"请把下面两段原样拼成一个词回复，中间不要有空格、不要换行，也不要说别的："
           f"第一段是 {_TOK_A} ，第二段是 {_TOK_B} 。"
           f"不要调用任何工具，不要写文件。")

_SPECS: dict[str, dict] = install_specs()

# Persist the latest probe result.
# Retain the previous successful probe across restarts.
_PROBE_FILE = os.path.join(_data_root(), "agent-probe.json")
_PROBE_LOCK = threading.Lock()

# Keep strong references to background jobs.
_JOBS: dict[str, dict] = {}
_JOB_LOCK = threading.Lock()
_JOB_THREADS: set = set()
_LOG_CAP = 400                      # Bound log history, including verbose npm output.


# Shared helpers.
def _package_files(pkg: str) -> list[str]:
    files = []
    if pkg == "@earendil-works/pi-coding-agent":
        bundled_cli = _bundled_pi_cli_js()
        if bundled_cli:
            files.append(os.path.join(os.path.dirname(os.path.dirname(bundled_cli)), "package.json"))
    for root in agent_npm_runtime.package_roots(_npm_root()):
        if pkg:
            files.append(os.path.join(root, *pkg.split("/"), "package.json"))
    return files


def _pkg_version(pkg: str) -> str:
    """Read live package metadata without launching npm or caching availability."""
    for package_file in _package_files(pkg):
        try:
            with open(package_file, encoding="utf-8") as f:
                version = str(json.load(f).get("version") or "")
            if version:
                return version
        except Exception:  # noqa: BLE001
            continue
    return ""


def _runtime_issue(key: str) -> str:
    if key == "opencode":
        return managed_agents.runtime_issue()
    if key == "harness2":
        from .harness2_lifecycle import disabled_issue
        return disabled_issue() or harness2_runtime.runtime_issue()
    if key == "codex":
        from .codex_account_acp import runtime_issue
        return runtime_issue()
    if key == "dsh":
        return _acp_runtime_issue("dsh")
    if key == "claude":
        return _acp_runtime_issue(key)
    if key != "codex-harness":
        return ""
    native = _codex_native_name()
    if not native:
        return "当前操作系统或 CPU 架构暂不受 Codex Harness 官方包支持。"
    codex_version = _codex_dependency_version()
    native_version = _codex_native_version()
    if not _codex_native_matches(codex_version, native_version):
        expected = ("（需要 " + codex_version + "）") if codex_version else ""
        return ("Codex Harness 安装不完整：缺少与适配器匹配的官方执行包 "
                + native + expected + "。请点一次“更新”自动补齐。")
    reported = _cached_version_probe(_codex_native_binary(), ["--version"], run=_short, timeout=8)
    if not reported or reported.split()[-1] != codex_version:
        return "Codex Harness 原生执行包启动自检失败，请检查系统运行库、目录权限或重新安装。"
    return ""


# Installation detection.
def _load_probes() -> dict:
    try:
        with open(_PROBE_FILE, encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:  # noqa: BLE001
        return {}


def _save_probe(key: str, rec: dict) -> None:
    with _PROBE_LOCK:
        cur = _load_probes()
        cur[key] = rec
        try:
            os.makedirs(os.path.dirname(_PROBE_FILE), exist_ok=True)
            with open(_PROBE_FILE, "w", encoding="utf-8") as f:
                json.dump(cur, f, ensure_ascii=False)
        except Exception as e:  # noqa: BLE001
            log.warning("探活结果没存下来: %s", type(e).__name__)


def _bin_of(key: str) -> str:
    try:
        return ((_PROFILES.get(key) or {}).get("bin") or (lambda: None))() or ""
    except Exception:  # noqa: BLE001
        return ""


def is_bundled(key: str) -> bool:
    """Whether this agent is shipped and lifecycle-managed by SoduWork."""
    if key == "harness2":
        return harness2_runtime.is_bundled()
    if key == "pi":
        return bool(_bundled_pi_cli_js() and _bundled_pi_node())
    return False


def _version_of(key: str) -> tuple[str, str, str]:
    """Read the package version first, falling back to the CLI. An executable-only installation is
    also valid.
    """
    if key == "harness2":
        return (harness2_runtime.version(), "bundled", "") if is_bundled(key) else ("", "", "")
    binp = _bin_of(key)
    spec = _SPECS.get(key) or {}
    if key == "claude":
        from .local_base import _claude_bin
        native = _claude_bin()
        ver = _cached_version_probe(native, ["--version"], run=_short) if native else ""
        return ver, "cli" if ver else "", ""
    if spec.get("installer") == "managed":
        if key == "opencode" and (issue := managed_agents._cpu_compatibility_issue()):
            return managed_agents._read_active(), "managed-record", issue
        ver = (_cached_version_probe(binp, ["--version"], run=_short,
                                     files=_package_files(spec.get("pkg", ""))) if binp else "")
        if ver:
            source = "bundled" if is_bundled(key) else (
                "managed" if managed_agents.managed_binary() else "cli")
            return ver, source, ""
        # Preserve installation evidence when the registered executable is gone
        # or fails to start. A record must never count as a successful probe.
        recorded = managed_agents._read_active() if key == "opencode" else ""
        source = "managed-record" if recorded else "pkg"
        recorded = recorded or _pkg_version(spec.get("pkg", ""))
        warning = ("找得到程序，但版本自检失败。建议重装。" if binp else
                   "保留了安装记录，但找不到执行程序。请点「重装」补齐。" if recorded else "")
        return recorded, source if recorded else "", warning
    ver = _pkg_version(spec.get("pkg", ""))
    if ver:
        return ver, "bundled" if is_bundled(key) else "pkg", (
            "保留了安装记录，但找不到执行程序。请点「重装」补齐。" if not binp else "")
    if not binp:
        return "", "", ""
    argv0 = list(((_PROFILES.get(key) or {}).get("argv_prefix") or (lambda: []))())
    ver = _cached_version_probe(binp, [*argv0, "--version"], run=_short,
                                files=_package_files(spec.get("pkg", "")))
    if ver:
        if (_SPECS.get(key) or {}).get("installer") != "npm":
            return ver, "cli", ""
        return ver, "cli", ("它自己报的版本是 " + ver + "，但 npm 那边没有这个包的记录"
                            "（全局包目录里只剩可执行文件）。这样升级、卸载都不会干净，"
                            "建议点一次「重装」把它补回来。")
    return "", "", "找得到可执行文件，却问不出版本——多半是装到一半。建议「重装」。"


def _auth_probe(key: str) -> tuple[str, str]:
    """Probe native account status in the same scope used by execution."""
    if key == "codex":
        from . import codex_account_home
        try:
            if codex_account_home.selected_home(_data_root()):
                state, _ = _account_auth_probe(key, _bin_of(key),
                    env=codex_account_home.environment(_data_root()))
                if state == "authed":
                    return "authed", "SoduWork 独立 Codex 账号已登录；新对话使用此账号"
                return state, "独立 Codex 账号未通过本机验证，请点击「登录 Codex」后新建对话"
        except Exception:
            return "", "Codex 独立登录设置无法读取，请检查 Runner 数据目录后重新登录"
    if key == "claude":
        from .local_base import _claude_bin
        from .claude_runtime import environment
        return _account_auth_probe(key, _claude_bin() or "", env=environment(_data_root()))
    return _account_auth_probe(key, _bin_of(key))


def detect(key: str, *, has_model: bool = True, probes: dict | None = None) -> dict:
    """The caller supplies model_catalog.usable as has_model; this status check does not query the
    database.
    """
    prof, spec = _PROFILES.get(key) or {}, _SPECS.get(key) or {}
    binp = _bin_of(key)
    pkg = spec.get("pkg", "")
    needs_llm = bool(prof.get("needs_llm"))
    bundled = is_bundled(key)
    ver, ver_from, warn_now = _version_of(key)
    # Harness uses the host Python executable, which is not proof that its
    # bundled core exists. Other runtimes can also leave metadata behind.
    present = bundled if key == "harness2" else bool(binp or ver or bundled)
    platform_issue = managed_agents._cpu_compatibility_issue() if key == "opencode" else ""
    runtime_issue = platform_issue or (_runtime_issue(key) if binp else "")
    # npm accepts unsupported engine versions with a warning. Treat an
    # installed CLI on an incompatible Node runtime as unavailable so the
    # Runner never advertises a seat that immediately crashes on dispatch.
    if binp and not bundled and (spec.get("installer") == "npm"):
        engine = agent_npm_runtime.package_engine(pkg, _npm_root())
        node_issue = node_env(key, engine=engine).get("why") or ""
        if node_issue:
            runtime_issue = node_issue
        elif not runtime_issue:
            argv = list((prof.get("argv_prefix") or (lambda: []))())
            if not _cached_version_probe(binp, [*argv, "--version"], run=_short,
                                         files=_package_files(pkg)):
                runtime_issue = "Agent 启动自检失败，请检查 Node 版本、系统架构和原生依赖。"
    if binp and not runtime_issue and spec.get("installer") in {"managed", "native"}:
        if ver_from not in {"managed", "cli", "bundled"}:
            runtime_issue = "Agent 启动自检失败，请检查系统运行库、目录权限或重新安装。"
    if not binp and present and not platform_issue:
        runtime_issue = "保留了安装记录，但找不到执行程序。请点「重装」补齐。"
    installed = bool(binp) and not runtime_issue
    if runtime_issue:
        warn_now = runtime_issue
    # Installation alone does not imply readiness; preserve the four distinct states.
    if not installed:
        state = "missing"
        why = ("还没装。点「装上」，SoduWork 会安装已校验的官方版本，"
               "不需要 Node/npm 或管理员权限。"
               if spec.get("installer") == "managed" else
               "还没装。点「装上」，SoduWork 替你完成安装。")
        install_how = str(spec.get("install_how") or "")
        if install_how:
            why = install_how
        if runtime_issue:
            why = runtime_issue
    elif needs_llm and not has_model:
        state, why = "nollm", "装好了，但 SoduWork 这边一个模型都用不了——去「我的模型」配一把 key。"
    elif bundled:
        name = str(prof.get("name") or key)
        state, why = "ready", (name + " 已随 SoduWork 内置，可以直接派活。"
                               "点「测一下」确认模型连接。")
    else:
        state, why = "ready", ("装好了，可以派活。建议点一次「测一下」确认真能跑通。"
                               if needs_llm else
                               "装好了。它用自己的账号，没登录过的话第一次跑会让你登录。")
    auth, auth_detail = ("", "")
    auth_status = ""
    if installed and not needs_llm and not bundled:
        auth, auth_detail = _auth_probe(key)
        auth_status = auth
        if key == "codex" and not auth:
            # Older Hubs only understand authed/unauthed. Fail closed for
            # dispatch while preserving uncertainty for current clients.
            auth, auth_status = "unauthed", "unknown"
            auth_detail = "暂时无法确认 Codex 登录状态，请重新检查或使用独立授权。"
        if auth == "authed" and state == "ready":
            why = auth_detail + "，可以直接派活。它用自己的模型，不占共享模型。"
        elif auth == "unauthed":
            state, why = "unauthed", "装好了，但" + auth_detail +                 "。它用自己的账号和模型，SoduWork 不会给它配共享模型。"
    # Keep the legacy state vocabulary for older desktop clients, which index
    # it directly. New clients use setupState without changing dispatch gates.
    setup_state = state
    if auth_status == "unknown":
        setup_state = "unknown"
        why = auth_detail
    if not installed:
        setup_state = "broken" if present or runtime_issue else "missing"
        if key == "harness2":
            from .harness2_lifecycle import disabled_issue
            if disabled_issue():
                setup_state = "disabled"
        if setup_state in {"setup", "disabled"}:
            warn_now = ""
    p = (probes if probes is not None else _load_probes()).get(key) or {}
    if key == "harness2":
        p = harness2_probe.visible_record(p)
    # Persisted probes are not bound to the current binary, account or model.
    # Return history explicitly without mutating the stored record.
    if p:
        p = {**p, "historical": True}
    return _decorate_agent({
        "key": key,
        "name": prof.get("name") or key,
        "pkg": pkg,
        "source": spec.get("source", ""),
        "blurb": spec.get("blurb", ""),
        "warn": spec.get("warn", ""),
        "installed": installed,
        "present": present,
        "setupState": setup_state,
        "runtimeIssue": runtime_issue,
        "bundled": bundled,
        "canUninstall": can_uninstall(key),
        "bin": binp,
        # Display Pi's actual Node and cli.js entry point.
        # Showing node.exe alone would hide which CLI is installed.
        "entry": (_pi_cli_js() or "") if key == "pi" else "",
        "auth": auth,
        "authStatus": auth_status,
        "authDetail": auth_detail,
        "loginAvailable": key == "codex" and bool(binp),
        "loginFlowVersion": 1 if key == "codex" and binp else 0,
        "isolatedLoginAvailable": key == "codex" and bool(binp),
        "accountSetup": _claude_account_setup(_data_root()) if key == "claude" and installed else {},
        "version": ver,
        "verFrom": ver_from,        # Distinguish package metadata from CLI fallback version detection.
        "warnNow": warn_now,        # Separate this machine's issue from general runtime requirements.
        "needsLlm": needs_llm,
        "configHow": spec.get("config_how", ""),
        "configPath": spec.get("config_path", ""),
        "configReady": _config_ready(key),
        "state": state,
        "why": why,
        "probe": p,                 # {ok, detail, at, steps:[...]}
    })


def _config_ready(key: str) -> bool:
    """Check Pi configuration; other runtimes pass this gate because they do not use that
    configuration contract.
    """
    path = (_SPECS.get(key) or {}).get("config_path") or ""
    if not path:
        return True
    return os.path.isfile(os.path.expanduser(path))


def detect_all(*, has_model: bool = True) -> list[dict]:
    """List all supported agents, including missing agents that the user can install."""
    probes = _load_probes()
    # Discovery can release the GIL while the private desktop pipe adds an ACP
    # declaration. Snapshot identities so that scan remains a coherent batch.
    return [detect(k, has_model=has_model, probes=probes) for k in list(_SPECS)]


# Installation, version-check, and probe jobs.
def _new_job(key: str, action: str) -> str:
    jid = uuid.uuid4().hex[:12]
    with _JOB_LOCK:
        _JOBS[jid] = {"id": jid, "key": key, "action": action, "state": "running",
                      "lines": [], "ok": None, "detail": "", "code": None,
                      "startedAt": time.time(), "endedAt": None}
        # Retain active jobs so a live login can always be cancelled by its ID.
        if len(_JOBS) > 30:
            finished = [j for j in _JOBS.values() if j["state"] == "done"]
            for old in sorted(finished, key=lambda j: j["startedAt"])[:len(_JOBS) - 30]:
                _JOBS.pop(old["id"], None)
    return jid


def _say(jid: str, line: str) -> None:
    with _JOB_LOCK:
        j = _JOBS.get(jid)
        if j is None:
            return
        j["lines"].append(line[:400])
        if len(j["lines"]) > _LOG_CAP:
            del j["lines"][:len(j["lines"]) - _LOG_CAP]


def _done(jid: str, ok: bool, detail: str, code: int | None = None) -> None:
    with _JOB_LOCK:
        j = _JOBS.get(jid)
        if j is None:
            return
        j.update(state="done", ok=ok, detail=detail, code=code, endedAt=time.time())


def job(jid: str, *, owner_id: str | None = None) -> dict | None:
    with _JOB_LOCK:
        j = _JOBS.get(jid)
        if (j and owner_id is not None and j.get("action") in {"login", "login-isolated"}
                and j.get("_owner", "") != owner_id):
            return None
        return {k: v for k, v in j.items() if not k.startswith("_")} if j else None


def _spawn(jid: str, fn, *args) -> None:
    th = threading.Thread(target=_guard, args=(jid, fn, *args), daemon=True)
    _JOB_THREADS.add(th)                     # Retain a strong reference to the background task.
    th.start()


def _guard(jid: str, fn, *args) -> None:
    try:
        fn(jid, *args)
    except Exception as e:  # noqa: BLE001
        log.exception("agent 作业炸了")
        _say(jid, f"[异常] {type(e).__name__}: {e}")
        _done(jid, False, f"没跑成（{type(e).__name__}）：{str(e)[:120]}")
    finally:
        with _JOB_LOCK:
            j = _JOBS.get(jid)
            unfinished = j is not None and j["state"] != "done"
        if unfinished:
            _done(jid, False, "作业没有正常收尾")


def _stream(jid: str, argv: list[str], *, cwd: str | None = None, env: dict | None = None,
            timeout: int = 600, quiet_re: str = "",
            stdin_text: str | None = None) -> tuple[int, str]:
    """Stream subprocess progress and return the exit code plus full output. quiet_re hides display
    lines while retaining raw output for checks.
    """
    _say(jid, "$ " + " ".join(argv))
    from .local_stream import _kill_pid_tree
    proc = subprocess.Popen(
        argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,






        stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
        cwd=cwd, env=env,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        **({} if _WIN else {"start_new_session": True}))
    buf: list[str] = []
    quiet = re.compile(quiet_re) if quiet_re else None
    deadline = time.monotonic() + timeout
    timed_out = threading.Event()
    def expire() -> None:
        if proc.poll() is None:
            timed_out.set()
            _kill_pid_tree(proc.pid, proc)
    killer = threading.Timer(max(1, timeout), expire)
    killer.daemon = True
    killer.start()
    if stdin_text is not None:
        def _feed() -> None:
            try:
                assert proc.stdin is not None
                proc.stdin.write(stdin_text)
                proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
        threading.Thread(target=_feed, daemon=True).start()

    try:
        for line in proc.stdout:                       # type: ignore[union-attr]
            line = line.rstrip("\r\n")
            buf.append(line)
            if line.strip() and not (quiet and quiet.search(_probe_console_text(line))):
                _say(jid, line)
    finally:
        try:
            # stdout EOF is not process completion. Keep the original deadline
            # armed until the owned command exits, including its final wait.
            proc.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            expire()
            proc.wait(timeout=5)
        finally:
            killer.cancel()
            if proc.stdout is not None:
                proc.stdout.close()
    code = proc.returncode if proc.returncode is not None else 1
    if timed_out.is_set() or time.monotonic() > deadline:
        code = 124
        _say(jid, "[超时] 跑太久，已经把它收掉了")
    return code, "\n".join(buf)


# ---- Install / uninstall / update ----
def can_uninstall(key: str) -> bool:
    """Pi is required even when its bundled payload is absent or being repaired."""
    return key in _SPECS and key != "pi" and (key == "harness2" or not is_bundled(key))


def start_install(key: str, action: str, *, owner_id: str = "") -> str:
    """Start an explicit lifecycle or account-login job and return its polling ID."""
    if key not in _SPECS:
        raise ValueError("Unknown Agent installation target")
    if action not in {"install", "update", "uninstall", "check", "login", "login-isolated"}:
        raise ValueError("Unsupported Agent installation action")
    if action.startswith("login") and key != "codex":
        raise ValueError("Account login is supported only for Codex")
    jid = _new_job(key, action)
    if action == "uninstall" and not can_uninstall(key):
        _done(jid, False, "该底座是 SoduWork 必需组件，不能单独卸载。")
        return jid
    if action.startswith("login"):
        from . import codex_login_flow
        with _JOB_LOCK:
            _JOBS[jid].update(_owner=owner_id, auth={"state": "checking"})
        if not codex_login_flow.reserve(jid, _data_root()):
            with _JOB_LOCK:
                _JOBS[jid]["auth"] = {"state": "failed", "reason": "login_busy"}
            _done(jid, False, "这台电脑已有 Codex 授权正在进行，请先完成或取消", 409)
            return jid
        _spawn(jid, _run_codex_login)
        return jid
    if key == "harness2":
        from .agent_setup_harness2 import run
        _spawn(jid, run, action)
        return jid
    if is_bundled(key):
        version = _version_of(key)[0]
        name = str((_PROFILES.get(key) or {}).get("name") or key)
        if action == "uninstall":
            _done(jid, False, name + " 是 SoduWork 内置组件，不能单独卸载。")
        else:
            label = f"{name} {version}" if version else name
            _done(jid, True, f"{label} 已随 SoduWork 内置；"
                  "无需单独安装，升级 SoduWork 时会一起升级。")
        return jid
    spec = _SPECS.get(key) or {}
    if spec.get("installer") == "manual":
        _done(jid, False, str(spec.get("install_how") or
                              "Install this Agent in an isolated Runner environment, then retry detection."))
        return jid

    if spec.get("installer") == "native":
        _spawn(jid, _run_native, key, action)
        return jid

    if spec.get("installer") == "managed":
        _spawn(jid, _run_managed, key, action)
    else:
        _spawn(jid, _run_npm, key, action)
    return jid


def _run_codex_login(jid: str) -> None:
    from . import codex_login_flow
    def publish(auth):
        with _JOB_LOCK:
            if jid in _JOBS:
                _JOBS[jid]["auth"] = dict(auth)
    with _JOB_LOCK:
        isolated = (_JOBS.get(jid) or {}).get("action") == "login-isolated"
    ok, detail, code = codex_login_flow.run(jid, _bin_of("codex"), _data_root(),
                                         publish=publish, isolated=isolated)
    _done(jid, ok, detail, code)


def cancel_login(jid: str, *, owner_id: str = "") -> dict:
    """Cancel only the requested login, never the machine's newest job."""
    from . import codex_login_flow
    with _JOB_LOCK:
        current = _JOBS.get(jid)
        if (not current or current.get("key") != "codex" or current.get("action") not in {"login", "login-isolated"}
                or current.get("_owner", "") != owner_id):
            raise ValueError("没有这个 Codex 授权任务，或任务不属于当前账号")
        if current["state"] == "done":
            return {"jobId": jid, "cancelled": False, "state": "done"}
    cancelled = codex_login_flow.cancel(jid, _data_root())
    return {"jobId": jid, "cancelled": cancelled, "state": "cancelling"}


def _run_managed(jid: str, key: str, action: str) -> None:
    try:
        ok, detail = managed_agents.install(action, lambda line: _say(jid, line))
        _done(jid, ok, detail)
    except Exception as exc:  # noqa: BLE001
        _done(jid, False, "OpenCode 安装失败：" + str(exc)[:220])


@agent_npm_runtime.serial_install
def _run_native(jid: str, key: str, action: str) -> None:
    """Run a Runner-isolated vendor binary installer without Node or shell scripts."""
    try:
        ok, detail = agent_native_install.install(
            _data_root(), action, emit=lambda line: _say(jid, line))
    except (OSError, RuntimeError, ValueError) as exc:
        _done(jid, False, "Claude Code native installation failed: " + str(exc)[:300], 2)
        return
    if not ok:
        _done(jid, False, detail or "Claude Code native installation failed", 2)
        return
    if action in {"install", "update"}:
        from .claude_runtime import install_adapter
        issue = install_adapter(
            execute=lambda argv, **opts: _stream(jid, argv, **opts),
            say=lambda line: _say(jid, line))
        if issue:
            _done(jid, False, issue, 2)
            return
        agent_npm_runtime.activate_environment()
    _done(jid, True, detail or "Claude Code native installation complete", 0)


@agent_npm_runtime.serial_install
def _run_npm(jid: str, key: str, action: str) -> None:
    if action == "uninstall" and not can_uninstall(key):
        _done(jid, False, "该底座是 SoduWork 必需组件，不能单独卸载。")
        return
    spec = _SPECS.get(key) or {}
    pkg = spec.get("pkg") or ""
    version = str(spec.get("version") or "").strip()
    target_pkg = pkg + ("@" + version if version else "")
    if not pkg:
        _done(jid, False, "该 Agent 缺少安装包定义")
        return
    env = node_env(key if action in {"install", "update", "check"} else "")
    if not env.get("ok"):
        _done(jid, False, env.get("why") or "Node.js 版本不满足该 Agent 的要求")
        return
    npm = [env["nodePath"], env["npmPath"]]
    process_env = agent_npm_runtime.environment(env, install=True)
    def run(args, **kwargs):
        return agent_npm_network.run(npm, args, env=process_env,
            execute=lambda argv, **opts: _stream(jid, argv, **opts),
            say=lambda line: _say(jid, line), **kwargs)
    if action == "check":
        # Registry version checks are read-only.
        # Checking a version does not modify installed software.
        code, out = run(["view", target_pkg, "version"], timeout=90)
        latest = (out.strip().splitlines() or [""])[-1].strip()
        # Use package metadata with CLI fallback, matching installation detection.
        # Executable-only installations remain valid.
        cur = _version_of(key)[0]
        if code != 0 or not latest:
            _done(jid, False, "查不到版本（多半是这台机器连不上 npm registry）", code)
            return
        if not cur:
            _done(jid, True, f"最新是 {latest}，你这台还没装", code)
        elif cur == latest:
            issue = _runtime_issue(key)
            if issue:
                _done(jid, False, f"适配器已经是最新的 {cur}，但{issue}", 2)
            else:
                _done(jid, True, f"已经是最新的 {cur}", code)
        else:
            _done(jid, True, f"有新版：{cur} → {latest}", code)
        return
    if action == "uninstall":
        packages = [pkg]
        # Codex's native package is shared with personal-account execution.
        # Removing an adapter must not remove another runtime's dependency.
        code, _ = run(["uninstall", "-g", *packages], timeout=300)
        if code == 0 and key == "dsh":
            try:
                dsh_runtime.remove_host(_data_root())
            except Exception as exc:  # noqa: BLE001
                _done(jid, False, "适配器已卸载，但 SoduWork 运行时清理失败：" + str(exc)[:220], 2)
                return
        # Verify executable removal after uninstall; npm's exit code alone is insufficient.
        # Leftover executables may remain runnable.
        left = _bin_of(key)
        if code == 0 and not left:
            _done(jid, True, "卸干净了", code)
        elif code == 0:
            _done(jid, False, "npm 说卸掉了，但可执行文件还在：" + left, code)
        else:
            _done(jid, False, f"卸载失败（npm 退出码 {code}）", code)
        return
    # Install and update use the catalog pin when one is declared; other
    # packages retain their existing latest-version behavior.
    runtime_detail = ""
    code, _ = run(["install", "-g", "--include=optional", "--engine-strict", target_pkg], timeout=900)
    agent_npm_runtime.activate_environment()
    if code == 0 and key == "codex":
        from .codex_account_acp import PACKAGE
        _say(jid, "正在补齐 Codex 安全权限适配器，保留个人账号登录…")
        code, _ = run(["install", "-g", "--include=optional", "--engine-strict", PACKAGE], timeout=900)
        agent_npm_runtime.activate_environment()
    if code == 0 and key == "dsh":
        stage = ""
        try:
            _say(jid, "正在校验并准备 DeepSeek Harness 固定版本运行时…")
            plan = dsh_runtime.stage_bundled_runtime(
                _data_root(), _bin_of(key), agent_npm_runtime.private_root() or _npm_root())
            stage = str(plan["path"])
            for native in plan.get("nativePackages") or []:
                label = f"{native['name']}@{native['version']}"
                _say(jid, "正在补齐当前系统原生组件：" + label)
                pack_argv = dsh_runtime.native_pack_argv(env["npmPath"], stage, native)
                if not pack_argv:
                    raise RuntimeError("无法生成原生组件下载命令：" + label)
                native_code, _ = run(pack_argv[1:], timeout=300)
                if native_code != 0:
                    code = native_code
                    raise RuntimeError("原生组件下载失败：" + label)
                dsh_runtime.install_native_pack(stage, native)
            _say(jid, "正在启动临时运行时，验证完整插件树…")
            # A freshly extracted Windows plugin tree can exceed 20 seconds on
            # its first boot. Keep the complete ACP handshake and a bounded
            # cold-start budget; ordinary runtime probes retain their deadline.
            stage_issue = dsh_runtime.stage_boot_issue(
                _bin_of(key), stage, str(plan["version"]), timeout=60)
            if stage_issue:
                raise RuntimeError(stage_issue)
            dsh_runtime.activate_stage(
                stage, _data_root(), str(plan["version"]),
                str(plan.get("sha256") or ""))
            stage = ""
            _say(jid, "DeepSeek Harness 执行运行时已通过完整性校验并启用。")
        except Exception as exc:  # noqa: BLE001
            runtime_detail = "DeepSeek Harness 运行时准备失败：" + str(exc)[:300]
            _say(jid, runtime_detail)
            code = code or 2
        finally:
            dsh_runtime.discard_stage(stage)
    if code == 0 and key == "codex-harness" and not _codex_native_matches(
            _codex_dependency_version(), _codex_native_version()):
        from .agent_codex_install import repair_native
        _say(jid, "正在补齐当前平台的 Codex 官方执行包…")
        code, runtime_detail = repair_native(run)
        if runtime_detail:
            _say(jid, runtime_detail)
    ver = _pkg_version(pkg)
    issue = _runtime_issue(key)
    if code == 0 and key == "dsh" and not issue:
        issue = _acp_runtime_issue("dsh", probe=True)
    if code == 0 and not issue:
        executable = _bin_of(key)
        prefix = list(((_PROFILES.get(key) or {}).get("argv_prefix") or (lambda: []))())
        if not executable or not _short(executable, [*prefix, "--version"]):
            issue = "安装包已写入，但 Agent 启动自检失败；请检查 Node 版本、系统架构和原生依赖。"
    runtime_ready = not issue
    if code == 0 and ver and runtime_ready:
        _done(jid, True, f"装好了：{pkg}@{ver}", code)
    else:
        # A zero exit code is insufficient unless the package is actually installed.
        detail = (runtime_detail or issue or
                  f"没装上（npm 退出码 {code}）。日志里搜 npm ERR! 看原因。")
        _done(jid, False, detail, code)


# Runtime probes.
def start_probe(key: str, llm: dict) -> str:
    """The caller resolves llm base, key, and model using the dispatch credentials. An empty
    configuration selects runtime-managed authentication.
    """
    jid = _new_job(key, "probe")
    _spawn(jid, _run_probe, key, llm or {})
    return jid


def _probe_ws() -> str:
    """Use a temporary probe directory under LOCALAPPDATA, avoiding repository or home-directory
    pollution.
    """
    d = os.path.join(_data_root(), "agent-probe")
    os.makedirs(d, exist_ok=True)
    return d


def _probe_args(key: str, args: list[str]) -> list[str]:
    """Run a minimal real probe without user sessions or extensions."""
    out = list(args)
    if key == "harness2":
        out.append("--probe")
    if key == "pi":
        out += ["--no-session", "--no-tools", "--no-extensions", "--no-skills",
                "--no-prompt-templates", "--no-themes", "--no-context-files"]
    return out


def _run_probe(jid: str, key: str, llm: dict) -> None:
    prof = _PROFILES.get(key) or {}
    steps: list[dict] = []

    def _fin(ok: bool, detail: str) -> None:
        rec = {"ok": ok, "detail": detail, "at": time.time(), "steps": steps}
        if key == "harness2" and ok:
            rec["coverage"] = harness2_probe.COVERAGE
        _save_probe(key, rec)
        _done(jid, ok, detail)

    binp = _bin_of(key)
    if not binp:
        steps.append({"name": "装了吗", "ok": False, "detail": "找不到可执行文件"})
        _fin(False, "还没装。先点「装上」。")
        return

    # First check process startup without spending model tokens.
    argv0 = list((prof.get("argv_prefix") or (lambda: []))())      # Pi uses its cli.js entry point.
    _say(jid, "① 先看它跑不跑得起来…")
    ver = _short(binp, [*argv0, "--version"], timeout=25)
    if not ver:
        steps.append({"name": "跑得起来吗", "ok": False, "detail": "问它版本，没有回话"})
        _fin(False, "装是装了，但它跑不起来（问版本都不吭声）。多半是装坏了——试试「重装」。")
        return
    steps.append({"name": "跑得起来吗", "ok": True, "detail": ver})
    _say(jid, "   版本：" + ver)

    # Then perform a minimal model request.
    if prof.get("needs_llm") and not (llm.get("base") and llm.get("key") and llm.get("model")):
        steps.append({"name": "能干活吗", "ok": False, "detail": "还没有能用的模型"})
        _fin(False, "它跑得起来，但 SoduWork 这边没有能用的模型——先去「我的模型」配一把 key。")
        return

    from .local_base import _env_for
    cfg = {"llm": llm, "local_cli": key}
    # _env_for writes models.json and prepares environment variables.
    # Reuse the execution configuration logic.
    try:
        ws = _probe_ws()
        sid = str(uuid.uuid4())
        start = prof.get("start") or (lambda *a, **k: [])
        if key == "codex":
            from . import access_policy
            # The chat path selects account ACP before building its environment.
            # Use that same path in a private readonly workspace; legacy exec
            # success does not prove the installed permission adapter works.
            cfg["accessPolicy"] = access_policy.normalize({
                "schema": access_policy.SCHEMA, "mode": "readonly", "revision": 1,
                "workspaceRoot": os.path.abspath(ws)})
            args = _probe_args(key, start(sid, "plan", ws, cfg))
            env = _env_for(prof, cfg, runtime_ref="probe-" + sid)
        else:
            env = _env_for(prof, cfg)
            args = _probe_args(key, start(sid, "work", ws, cfg))
    except Exception as e:  # noqa: BLE001
        from .codex_runtime_home import CodexLoginError
        # Only this typed error guarantees that its public text omits secrets.
        detail = (str(e) if isinstance(e, CodexLoginError) else
                  f"准备 CLI 运行环境失败（{type(e).__name__}），请检查依赖、配置与目录权限后重试")
        steps.append({"name": "能干活吗", "ok": False, "detail": detail})
        _fin(False, detail)
        return
    _say(jid, harness2_probe.INTRO if key == "harness2" else
         "② 让它真干一轮最小的活（要它把两段拼成一个词说回来）…")
    # Hide raw JSON protocol lines from user-facing logs.
    # Machine-readable JSON is not progress text.
    # Display progress and the final verdict.
    # _why_failed extracts errors while raw output remains available for validation.
    try:
        argv = _command_argv(binp, args, ws, cfg, prof)
        options = ({"timeout": harness2_probe.TIMEOUT}
                   if key == "harness2" else {"timeout": 180})
        code, out = _stream(jid, argv, cwd=ws, env=env, **options,
                            quiet_re=r"^\s*\{", stdin_text=_PROMPT)
    except Exception as e:  # noqa: BLE001 - keep persisted probe and job outcome consistent
        detail = f"CLI 测试进程未能正常运行（{type(e).__name__}），请检查依赖、可执行文件与目录权限后重试"
        steps.append({"name": "能干活吗", "ok": False, "detail": detail})
        _fin(False, detail)
        return
    # Determine success from response content, not only the exit code.
    # OpenCode can exit successfully after an authentication failure.
    # Require the joined marker in the response.
    # An echoed prompt cannot satisfy this check.
    hit = _probe_succeeded(out, code, _TOKEN)
    why = "" if hit else _why_failed(out, code)
    if key == "harness2" and hit and not harness2_probe.completed(out):
        hit, why = False, harness2_probe.MISSING_PROOF
    steps.append({"name": "能干活吗", "ok": hit,
                  "detail": ("把口令原样说回来了" if hit else why)})
    if hit:
        _say(jid, "   它把口令原样拼回来了：" + _TOKEN)
        _fin(True, harness2_probe.success_detail(ver) if key == "harness2" else
             f"通了 —— {prof.get('name')} {ver} 真跑了一轮，口令对上了。")
    else:
        # Include recognized failure reasons in the log.
        # Otherwise filtering JSON could hide the actual failure.
        _say(jid, "   没通：" + why)
        _fin(False, why)


def configure(key: str, llm: dict) -> dict:
    """Rewrite configuration without starting execution."""
    prof = _PROFILES.get(key) or {}
    if not prof:
        return {"ok": False, "detail": "没有这个 agent"}
    if not prof.get("needs_llm"):
        return {"ok": True, "detail": (_SPECS.get(key) or {}).get("config_how", "这个不用配")}
    if not (llm.get("base") and llm.get("key") and llm.get("model")):
        return {"ok": False, "detail": "还没有能用的模型——先去「我的模型」配一把 key"}
    from .local_base import _env_for
    _env_for(prof, {"llm": llm, "local_cli": key})
    return {"ok": True, "detail": (_SPECS.get(key) or {}).get("config_how", "配好了")}


__all__ = ["node_env", "detect", "detect_all", "is_bundled", "start_install",
           "start_probe", "job", "configure", "_SPECS"]
