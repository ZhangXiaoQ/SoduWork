"""Public module behavior and service contracts."""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

from .local_base import (_CTX_WINDOW_DEFAULT, _LOCK, _MEM_LINES, _PROFILES, _RUNS,
                         _WIN, _ANSI, _opencode_bin, _COMPACT_AT, _STORE, _friendly,
                         ctx_pct)
from .local_base import _append_events, _append_raw, _record_event, _record_terminal, _save_meta
from . import conversation_plugins, local_turn_outcome, local_context_policy

log = logging.getLogger("uvicorn.error")

_CODEX_TRANSPORT_NOISE = re.compile(
    r"^Reconnecting\.\.\. \d+/\d+|^Falling back from WebSockets to HTTPS transport",
    re.I)

_STALL_RETRY_LIMIT = max(0, int(os.environ.get("SODUWORK_LOCAL_STALL_RETRIES") or 1))
_STALL_RECOVERY_PROMPT = (
    "SoduWork 检测到上一轮长时间没有任何新输出，已经中断那一轮并自动续跑。\n"
    "不要重复已经完成的工作；先检查当前工作区、进程和服务的实际状态，从最后一步继续。"
    "完成剩余验证并给出最终可交付结果。如果确实无法继续，请明确写出唯一阻断原因和可执行的处理建议。"
)


def _pid_alive(pid: int) -> bool:
    """Check process liveness without psutil. On Linux, inspect /proc so a terminated zombie is not
    mistaken for a running process merely because kill(pid, 0) succeeds.
    """
    if not pid:
        return False
    try:
        if _WIN:
            # Compare the PID column in CSV output, not substrings that may match memory values.
            result = subprocess.run(
                ["tasklist", "/FI", "PID eq %d" % int(pid), "/NH", "/FO", "CSV"],
                capture_output=True, timeout=10)
            if result.returncode != 0:
                return True  # A failed process query cannot confirm that execution stopped.
            out = result.stdout.decode("utf-8", "replace")
            for line in out.splitlines():
                cols = [c.strip().strip('"') for c in line.split(",")]
                if len(cols) >= 2 and cols[1] == str(int(pid)):
                    return True
            return False
        if sys.platform.startswith("linux"):
            try:
                with open("/proc/%d/stat" % int(pid), "rb") as f:
                    tail = f.read().rsplit(b")", 1)[-1].split()
                return bool(tail) and tail[0] != b"Z"
            except FileNotFoundError:
                return False
            except (IndexError, OSError):
                pass
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True          # The process exists but belongs to another user.
    except Exception:  # noqa: BLE001
        return True          # Treat an inconclusive probe as alive so callers see failure instead of false stop confirmation.


def _kill_pid_tree(pid: int, proc=None) -> bool:
    """Terminate the process tree across platforms. Use taskkill /F /T on Windows; on Linux/macOS
    validate descendant identities, including separate ACP and terminal process groups. Fall
    back to process-group termination on other POSIX systems.
    """
    if not pid:
        return False
    try:
        if _WIN:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                           capture_output=True, timeout=20)
        elif sys.platform.startswith('linux'):
            from .linux_process_tree import kill_owned_tree
            kill_owned_tree(int(pid), proc)
        elif sys.platform == "darwin":
            from .darwin_process_tree import kill_owned_tree
            kill_owned_tree(int(pid), proc)
        else:
            import signal
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                if proc is not None:
                    proc.kill()
    except Exception as e:  # noqa: BLE001
        log.warning("叫停本地进程失败: %s", type(e).__name__)
        return False
    # Wait briefly and verify actual process exit after requesting termination.
    # Sending a kill request alone does not prove descendants have released the workspace.
    for _ in range(50):
        if not _pid_alive(pid):
            return True
        time.sleep(0.1)
    log.warning("叫停本地进程后 pid=%s 仍在运行", pid)
    return False


def _kill_tree(ref: str) -> bool:
    with _LOCK:
        run = _RUNS.get(ref) or {}
        proc, pid = run.get("proc"), run.get("pid")
    return _kill_pid_tree(pid, proc)


def is_running(ref: str) -> bool:
    """Check whether this execution is currently running, including reclaimed live processes, to
    determine stop availability.
    """
    with _LOCK:
        return (_RUNS.get(ref) or {}).get("state") == "running"


def stop_sync(cfg: dict, ref: str) -> dict:
    """Stop a locally controlled execution process."""
    with _LOCK:
        run = _RUNS.get(ref)
        if not run:
            return {"ok": False, "error": "这个本地会话不在了"}
        from . import access_transition
        if access_transition.cancel(run):
            _save_meta(ref)
            return {"ok": True, "stopped": True}
        if run.get("state") != "running":
            return {"ok": False, "error": "它这会儿没在跑"}
        run["stopping"] = True
        run["queue"] = []          # Clear queued follow-ups when stopping so execution does not immediately restart.
    from . import access_broker
    access_broker.close(ref)
    if run.get("contextCompacting"):
        return {"ok": True, "stopped": True}
    ok = _kill_tree(ref)
    if not ok:
        with _LOCK:
            r = _RUNS.get(ref)
            if r:
                r["stopping"] = False
        return {"ok": False, "error": "没能确认它停下来（进程可能还在收尾，稍后可再点一次）"}
    return {"ok": True, "stopped": True}


def forget_sync(cfg: dict, ref: str) -> dict:
    """Remove a stopped run from this machine's console records, preserving native CLI session
    archives and workspace outputs. Running sessions must be stopped first.
    """
    wanted = str(ref or "").strip()
    root = os.path.realpath(_STORE)
    target = os.path.realpath(os.path.join(root, wanted))
    try:
        safe = bool(wanted) and target != root and os.path.commonpath((root, target)) == root
    except ValueError:
        safe = False
    if not safe:
        return {"ok": False, "error": "会话存档路径不安全，已拒绝删除"}

    # Hold one lock across state checking, archive deletion, and memory removal to prevent a concurrent restart.
    with _LOCK:
        run = _RUNS.get(wanted)
        if not run:
            return {"ok": False, "error": "这个本地会话不在了"}
        if run.get("state") in {"running", "queued", "dispatching"} or run.get("stopping"):
            return {"ok": False, "error": "它还在跑，先停止再删除"}
        try:
            if os.path.isdir(target):
                shutil.rmtree(target)
            elif os.path.exists(target):
                return {"ok": False, "error": "会话存档路径不是目录，已拒绝删除"}
        except OSError as error:
            return {"ok": False, "error": "会话存档删除失败：" + str(error)}
        if os.path.exists(target):
            return {"ok": False, "error": "会话存档没有删除成功"}
        _RUNS.pop(wanted, None)
        from . import local_base
        local_base._RAW_SIZE.pop(wanted, None)
    return {"ok": True, "forgotten": True}


def _merge_runtime_cfg(current: dict | None, fresh: dict | None) -> dict:
    """Refresh per-turn credentials without dropping stable runtime grants.

    Conversation follow-ups only carry the model snapshot and the capabilities
    known by the desktop session.  The first dispatch may additionally contain
    repository and execution-policy settings.  Replacing the whole mapping here
    silently removed those settings on round two; a shallow top-level merge keeps
    omitted stable fields while still replacing an explicitly refreshed ``llm``.
    """
    merged = dict(current or {})
    merged.update(dict(fresh or {}))
    return merged


def _has_managed_model(cfg: dict | None) -> bool:
    llm = dict((cfg or {}).get("llm") or {})
    return bool(llm.get("base") and llm.get("key") and llm.get("model"))


def authorization_required_sync(ref: str) -> bool:
    """Whether a reclaimed active run needs its in-memory model grant again.

    Model secrets are deliberately absent from ``meta.json``.  After Runner is
    restarted, ``reclaim`` can reconnect the durable output stream but cannot
    reconstruct that secret.  The desktop session still owns a short-lived model
    snapshot and can re-authorize the run over the local control pipe.
    """
    with _LOCK:
        run = _RUNS.get(ref)
        if not run or run.get("state") not in ("running", "recovering"):
            return False
        prof = _PROFILES.get(str(run.get("cli") or "")) or {}
        return bool(prof.get("needs_llm") and not _has_managed_model(run.get("cfg")))


def authorize_sync(cfg: dict, ref: str) -> dict:
    """Restore one active run's managed-model grant in memory only."""
    fresh = dict(cfg or {})
    with _LOCK:
        run = _RUNS.get(ref)
        if not run:
            return {"ok": False, "error": "这个本地会话已经不在了"}
        cli = str(run.get("cli") or "")
        requested_cli = str(fresh.get("local_cli") or cli)
        if requested_cli != cli:
            return {"ok": False, "error": "模型授权与当前执行底座不匹配"}
        prof = _PROFILES.get(cli) or {}
        if not prof.get("needs_llm"):
            return {"ok": True, "accepted": False, "reason": "当前底座使用个人账号"}
        if run.get("state") not in ("running", "recovering"):
            return {"ok": True, "accepted": False, "reason": "当前会话无需恢复授权"}
        if not _has_managed_model(fresh):
            return {"ok": False, "error": "当前会话的模型授权不完整，请重新选择可用模型"}
        if fresh.get("accessPolicy"):
            from . import access_policy
            try:
                incoming = access_policy.normalize(fresh["accessPolicy"], run["ws"])
            except access_policy.PolicyError as exc:
                return {"ok": False, "error": str(exc)}
            if incoming != run.get("accessPolicy"):
                return {"ok": False, "code": "ACCESS_CHANGE_REQUIRES_STOP",
                        "error": "Model authorization cannot change access permissions"}
        run["cfg"] = _merge_runtime_cfg(run.get("cfg"), fresh)
    return {"ok": True, "accepted": True}


def comment_sync(cfg: dict, ref: str, text: str) -> dict:
    """Continue the same session for milestones or user follow-ups, preserving provider session
    context and working directory.
    """
    if (cfg or {}).get("_executionSelection") is not None:
        from .runner_turn_selection import validate
        try:
            validate(ref, cfg["_executionSelection"], cfg)
        except ValueError as exc:
            return {"ok": False, "code": getattr(exc, "code", "EXECUTION_SELECTION_INVALID"), "error": str(exc)}
    with _LOCK:
        run = _RUNS.get(ref)
    if not run:
        # Reclaim the archive after a Hub restart before delivering rework or milestone messages.
        # A missing memory entry alone does not mean the local session is lost.
        from .local_base import rehydrate
        run = rehydrate(ref)
    if not run:
        return {"ok": False, "error": "这个本地会话已经不在了"}
    if run.get("_accessTransition"):
        with _LOCK:
            run.setdefault("queue", []).append(text)
            fresh = {key: value for key, value in (cfg or {}).items()
                     if key not in {"accessPolicy", "_soduwork_agent_mode"}}
            if fresh:
                run["cfg"] = _merge_runtime_cfg(run.get("cfg"), fresh)
            return {"ok": True, "queued": True, "pending": len(run["queue"])}
    if run.get("state") == "running":
        fresh_policy = (cfg or {}).get("accessPolicy")
        if fresh_policy and fresh_policy != run.get("accessPolicy"):
            from . import access_policy
            try:
                normalized = access_policy.normalize(fresh_policy, run["ws"])
            except access_policy.PolicyError as exc:
                return {"ok": False, "error": str(exc)}
            if normalized != run.get("accessPolicy"):
                return {"ok": False, "code": "ACCESS_CHANGE_REQUIRES_STOP",
                        "error": "Stop the current turn before changing its access policy"}
        # Queue messages received during execution for the next turn.
        # This does not interrupt the current turn; stopping is a separate action.
        with _LOCK:
            run.setdefault("queue", []).append(text)
            if cfg:


                run["cfg"] = _merge_runtime_cfg(run.get("cfg"), cfg)
            n = len(run["queue"])
        return {"ok": True, "queued": True, "pending": n,
                "note": "它这一轮还在跑，你这句排在后面，跑完立刻接上（不打断）。"
                        "想立刻停请用「叫停」。"}
    if run.get("detached"):
        return {"ok": False, "error": "这条会话是后端重启前起的，实时输出接不回来了；"
                                      "可以叫停它，或者等它跑完收产出"}
    # Explicit user follow-up starts a new approval round; automatic recovery does not.
    with _LOCK:
        run.pop("_accessSessionDenials", None)
    return _resume(ref, text, cfg)



def record_user_sync(ref: str, text: str, attachments: list[dict] | None = None,
                     plugins: list[dict] | None = None, sent_at=None) -> dict:
    """Persist a user turn in the same ordered stream as agent output."""
    value = str(text or "").strip()
    if not value:
        return {"ok": False, "error": "empty user turn"}
    from .runtime_messages import epoch_ms
    item = _record_event(ref, {
        "kind": "user", "tool": "", "text": value[:20000], "full": value[:50000],
        "plugins": conversation_plugins.badges(plugins),
        "sentAt": epoch_ms(sent_at) or int(time.time() * 1000),
        "attachments": [{"name": str(row.get("name") or ""),
                         "path": str(row.get("path") or "")}
                        for row in (attachments or []) if isinstance(row, dict)],
    })
    return {"ok": bool(item), "item": item}

def _resume(ref: str, text: str, cfg: dict | None = None) -> dict:
    from .local_ctx import prepare_resume
    return prepare_resume(ref, text, cfg)


# Stream one execution turn.
def _spawn(exe: str, args: list, prompt: str, ws: str, ref: str,
           cfg: dict | None = None, prof: dict | None = None) -> None:
    from .local_process import spawn
    spawn(exe, args, prompt, ws, ref, cfg, prof,
          gate_check=_llm_gate_check, on_line=_on_line,
          finish=_finish, kill_tree=_kill_tree)


def _recover_stream(ref: str) -> None:
    from .local_process import recover
    recover(ref, on_line=_on_line, finish=_finish, kill_tree=_kill_tree)


# Parse an output line.
def _accumulate_usage(run: dict, usage: dict, *, cost=None, turns=None,
                      step: bool = False) -> None:
    """Accumulate provider-reported usage in run['usage'], separately from run['tokens'] context
    occupancy. Normalize runtime field names and preserve authoritative cost and turn
    information when supplied.
    """
    if not isinstance(usage, dict):
        return

    from .runtime_messages import usage as normalized_usage
    normalized = normalized_usage(usage)
    if normalized:
        usage = {**usage, **normalized}

    from .usage_values import normalize_usage as ledger_usage
    billed = ledger_usage({**usage, **({'cost': cost} if cost is not None else {})})
    if not any(billed[key] for key in ('total_tokens', 'cost_microusd', 'turns', 'steps')):
        return
    effective_input = billed['input_tokens'] + (0 if billed['input_includes_cache'] else
        billed['cache_read_tokens'] + billed['cache_write_tokens'])
    with _LOCK:
        acc = dict(run.get('usage') or {})
        had_usage = bool(acc.get('total'))
        prior_known = acc.get('costKnown', not had_usage or bool(acc.get('cost')))
        from decimal import Decimal, InvalidOperation
        prior_cost = Decimal(str(acc.get('costUsd', acc.get('cost') or 0)))
        raw_cost = usage.get('costUsd') if 'costUsd' in usage else (
            Decimal(billed['cost_microusd']) / 1_000_000
            if 'costMicrousd' in usage or 'cost_microusd' in usage else
            cost if cost is not None else usage.get('cost', 0))
        if isinstance(raw_cost, dict):
            raw_cost = raw_cost.get('total') or 0
        try:
            exact_cost = Decimal(str(raw_cost or 0))
        except InvalidOperation:
            exact_cost = Decimal(0)
        if not exact_cost.is_finite() or exact_cost < 0:
            exact_cost = Decimal(0)
        for key, amount in {
            'input': effective_input, 'output': billed['output_tokens'],
            'cacheRead': billed['cache_read_tokens'], 'cacheWrite': billed['cache_write_tokens'],
            'reasoning': billed['reasoning_tokens'], 'total': billed['total_tokens'],
            'requests': billed['requests'],
        }.items():
            acc[key] = int(acc.get(key) or 0) + amount
        acc['inputIncludesCache'] = True
        acc['costUsd'] = str(prior_cost + exact_cost)
        acc['costMicrousd'] = ledger_usage({'costUsd': acc['costUsd']})['cost_microusd']
        acc['cost'] = acc['costMicrousd'] / 1_000_000
        acc['costKnown'] = bool(prior_known and billed['cost_known'])
        if isinstance(turns, (int, float)):
            acc['turns'] = int(acc.get('turns') or 0) + int(turns)
        if step:
            acc['steps'] = int(acc.get('steps') or 0) + 1
        run['usage'] = acc


def _now_iso() -> str:
    # Runner may be in any company/timezone.  A naive local timestamp is interpreted as UTC
    # by the Hub and then clamped as "future", destroying the real event chronology.
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _items_from(m: dict, run=None) -> list[dict]:
    """Convert one JSON event into zero or more activity rows: say, do, or out. Bound display
    payloads because tool inputs can contain entire files.
    """
    from . import runtime_messages
    streamed = runtime_messages.items(m, run if run is not None else {})
    if streamed is not None:
        return streamed
    items: list[dict] = []
    part = m.get("part")
    # OpenCode event types include text, tool_use, step_start, and step_finish.
    if isinstance(part, dict):
        if m.get("type") == "text" and (part.get("text") or "").strip():
            _t = part["text"].strip()
            # Bound text for the live activity display.
            # Plan extraction reads the same events but needs complete responses.
            # A display truncation must not truncate the underlying plan.
            # Store full separately for parsing while text remains compact.
            it = {"kind": "say", "tool": "", "text": _t[:600]}
            if len(_t) > 600:
                it["full"] = _t[:20000]
            if len(_t) > 20000:
                it["textTruncated"] = True
            items.append(it)
        elif m.get("type") == "tool_use":
            inp = ((part.get("state") or {}).get("input")) or {}
            # Extract short path and command fields, never an entire file-content argument.
            brief = (inp.get("filePath") or inp.get("command") or inp.get("path")
                     or inp.get("pattern") or "")
            # Do not repeat the tool name inside display text.
            # The UI renders tool and argument text separately.
            items.append({"kind": "do", "tool": str(part.get("tool") or ""),
                          "text": str(brief)[:300], "callId": str(part.get("callId") or part.get("id") or ""),
                          "toolKind": str(part.get("toolKind") or "")[:40],
                          "arguments": runtime_messages.short_arguments(inp)})
        return items
    # Pi event parsing.
    # message_update wraps thinking, text, and tool-call assistant events.
    # Collect completed fragments rather than every character delta.
    # This avoids fragmented displays and excessive structured-log growth.
    ame = m.get("assistantMessageEvent")
    if isinstance(ame, dict):
        et = ame.get("type")
        if et == "text_end":
            _t = str(ame.get("content") or "").strip()
            if _t:
                it = {"kind": "say", "tool": "", "text": _t[:600]}
                if len(_t) > 600:
                    it["full"] = _t[:20000]     # Retain the full response for plan parsing, as with OpenCode.
                if len(_t) > 20000:
                    it["textTruncated"] = True
                items.append(it)
        elif et == "toolcall_end":
            tc = ame.get("toolCall") or {}
            a = tc.get("arguments") or {}
            # Extract short paths and commands rather than complete write-tool content.
            brief = (a.get("path") or a.get("command") or a.get("file_path")
                     or a.get("filePath") or a.get("pattern") or a.get("query") or "")
            items.append({"kind": "do", "tool": str(tc.get("name") or ""),
                          "text": str(brief)[:300], "callId": str(tc.get("id") or ""),
                          "arguments": runtime_messages.short_arguments(a)})
        return items
    # Codex JSONL event parsing.
    # item.completed contains agent messages and intermediate diagnostics.
    # Intermediate error items are not terminal failures; turn.failed determines failure.
    if str(m.get("type") or "") == "item.completed" and isinstance(m.get("item"), dict):
        it = m["item"]
        it_type = str(it.get("type") or "")
        if it_type == "agent_message" and (it.get("text") or "").strip():
            _t = str(it["text"]).strip()
            row = {"kind": "say", "tool": "", "text": _t[:600]}
            if len(_t) > 600:
                row["full"] = _t[:20000]     # Retain the full response for plan parsing.
            if len(_t) > 20000:
                row["textTruncated"] = True
            items.append(row)
        elif it_type == "error" and (it.get("message") or "").strip():
            message = str(it["message"])
            if not _CODEX_TRANSPORT_NOISE.search(message):
                items.append({"kind": "out", "tool": "提示", "text": message[:300]})
        elif it_type:
            # Use a conservative fallback for other item types.
            # Display the type and bounded known fields, never an unbounded full item.
            brief = (it.get("command") or it.get("path") or it.get("text") or "")
            items.append({"kind": "do", "tool": it_type, "text": str(brief)[:300],
                          "callId": str(it.get("id") or ""), "arguments": runtime_messages.short_arguments(it)})
        return items
    # Top-level Codex error messages may describe reconnect attempts and remain activity output.
    # turn.failed carries the terminal error through the common failure path.
    if str(m.get("type") or "") == "error" and isinstance(m.get("message"), str):
        if not _CODEX_TRANSPORT_NOISE.search(m["message"]):
            items.append({"kind": "out", "tool": "错误", "text": m["message"][:400]})
        return items
    # Pi lifecycle scaffolding does not generate activity rows.
    # turn_end, agent_end, and message_end can contain complete messages already emitted.
    # Do not pass them through generic parsing and duplicate the conversation.
    if str(m.get("type") or "") in (
            "session", "agent_start", "turn_start", "turn_end", "agent_end", "agent_settled",
            "message_start", "message_end", "tool_execution_start",
            "thread.started", "turn.completed", "turn.failed"):
        return items
    if str(m.get("type") or "") == "tool_execution_end":
        # Extract bounded tool-result output, especially failure diagnostics.
        r = m.get("result")
        if isinstance(r, dict) and isinstance(r.get("content"), list):
            txt = "\n".join(str(b.get("text") or "") for b in r["content"] if b.get("type") == "text")
        else:
            txt = r if isinstance(r, str) else json.dumps(r, ensure_ascii=False) if r else ""
        items.append({"kind": "out", "tool": str(m.get("toolName") or ""),
                      "text": txt.strip()[:300], "full": txt.strip()[:20000],
                      "callId": str(m.get("toolCallId") or ""), "isError": bool(m.get("isError")),
                      **runtime_messages.cancel_fields(m)})
        return items
    # Claude event parsing.
    for blk in (((m.get("message") or {}).get("content")) or []):
        if not isinstance(blk, dict):
            continue
        if blk.get("type") == "text" and (blk.get("text") or "").strip():
            text = blk["text"].strip()
            row = {"kind": "say", "tool": "", "text": text[:600], "full": text[:20000]}
            if len(text) > 20000:
                row["textTruncated"] = True
            items.append(row)
        elif blk.get("type") == "tool_use":
            inp = blk.get("input") or {}
            brief = inp.get("command") or inp.get("file_path") or inp.get("path") or ""
            items.append({"kind": "do", "tool": blk.get("name", ""), "text": str(brief)[:300],
                          "callId": str(blk.get("id") or ""), "arguments": runtime_messages.short_arguments(inp)})
    return items


# Match explicit context-window limits before other numbers in overflow errors.
#    "The input (967086 tokens) is longer than the model's context length (800000 tokens)."
# The first number may be consumed input, not the supported window size.
_CTX_PATS = [
    re.compile(r"context\s+length[^\d]{0,24}(\d{4,8})", re.I),
    re.compile(r"context\s+window[^\d]{0,24}(\d{4,8})", re.I),
    re.compile(r"\[\s*\d+\s*,\s*(\d{4,8})\s*\]"),          # Example provider format: Range of input length should be [1, 129024].
    re.compile(r"maximum[^\d]{0,30}(\d{4,8})", re.I),
]


def _learn_window(run: dict, text: str) -> None:
    """Extract the actual model window from an overflow error and replace the prior estimate when valid."""
    for pat in _CTX_PATS:
        m = pat.search(text or "")
        if not m:
            continue
        try:
            n = int(m.group(1))
        except Exception:  # noqa: BLE001
            continue
        if 4000 <= n <= 8000000:
            run["ctxWindow"] = n
            run["ctxWindowKnown"] = True
            _remember_window(((run.get("cfg") or {}).get("llm") or {}).get("model") or "", n)
            return


def _windows_path() -> str:
    os.makedirs(_STORE, exist_ok=True)
    return os.path.join(_STORE, "model-windows.json")


def _remember_window(model: str, n: int) -> None:
    """Persist learned limits so later runs of the same model start with the observed denominator.

    """
    if not model:
        return
    try:
        d = _load_windows()
        if d.get(model) == n:
            return
        d[model] = n
        with open(_windows_path(), "w", encoding="utf-8") as f:
            json.dump(d, f)
        log.info("记住模型窗口：%s = %d", model, n)
    except Exception:  # noqa: BLE001
        pass


def _load_windows() -> dict:
    try:
        with open(_windows_path(), encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:  # noqa: BLE001
        return {}


def _window_for(cfg: dict) -> tuple[int, bool]:
    from . import context_window
    llm = ((cfg or {}).get("llm") or {})
    resolved = context_window.resolve(llm)
    if resolved["contextWindowSource"] != "safe-default":
        return resolved["contextWindow"], True
    model = llm.get("model") or ""
    n = _load_windows().get(model)
    return (int(n), True) if n else (resolved["contextWindow"], True)


_OVERFLOW_PAT = local_context_policy.OVERFLOW

# Suppress recognized expected lifecycle noise from the activity view.
# Keep it in raw diagnostics for troubleshooting.
# Pi receives a SoduWork-assigned session ID before its first turn.
# The first invocation may report that no session exists and it is creating one.
# That is expected session creation, not lost-session evidence.
_EXPECTED_NOISE = re.compile(
    r"No project session found with id .+; creating a new session|"
    r"Reading prompt from stdin|shell_snapshot: Failed to create shell snapshot|"
    r"codex_core::responses_retry: stream disconnected|"
    r"codex_core::client: falling back to HTTP|"
    r"codex_api::endpoint::responses_websocket: failed to connect",
    re.I)


def _llm_gate_check(prof: dict, cfg: dict) -> str:
    """Check direct connectivity to the model gateway before starting execution.
    
    Use the same direct connection as model requests. Any HTTP response proves network reachability;
    later requests handle authentication and endpoint errors. Block execution only on connection failure,
    and report an actionable message before the runtime starts.
    """
    if not prof.get("needs_llm"):
        return ""
    base = str(dict((cfg or {}).get("llm") or {}).get("base") or "").strip()
    if not base:
        return ""
    import urllib.error
    import urllib.request
    from urllib.parse import urlparse
    host = urlparse(base).hostname or base
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        opener.open(urllib.request.Request(
            base.rstrip("/") + "/models", headers={"User-Agent": "SoduWork-Gate/1"}),
            timeout=5).close()
        return ""
    except urllib.error.HTTPError:
        return ""       # An HTTP response proves reachability even when authentication or routing fails.
    except Exception as e:  # noqa: BLE001
        return ("这台执行机连不上模型网关 %s（直连失败：%s）。"
                "请检查这台机器的网络连接与 DNS；SoduWork 对模型网关默认直连，"
                "若该网络必须经代理访问网关，请联系管理员。" % (host, type(e).__name__))


# Pi character deltas include thinking_delta, text_delta, and toolcall_delta.
# Require both Pi-specific markers to avoid filtering unrelated runtime lines containing _delta.
_PI_DELTA = re.compile(r'"assistantMessageEvent"\s*:\s*\{\s*"type"\s*:\s*"[a-z]+_delta"')

_EXTERNAL_DIR = re.compile(
    r"permission requested:\s*external_directory\s*\((.+?)\);\s*auto-rejecting", re.I)


def _on_line(ref: str, raw: str, term: dict, stream: str = "out",
             stream_end: int = 0) -> None:
    """Handle each line independently: retain diagnostics, parse activity, persist events, and
    update occupancy and terminal state. A malformed line must not abort the stream reader.
    """
    terminal_before = dict(term)
    # Do not write Pi character-delta snapshots to raw.log.
    # Repeated partial-message snapshots can cause quadratic log growth.
    # Completed events retain the full content needed for diagnostics.
    if not _PI_DELTA.search(raw):
        _append_raw(ref, raw)
    with _LOCK:
        run = _RUNS.get(ref)
        if run is None:
            return
        run["lastOut"] = time.time()
    ln = _ANSI.sub("", raw).strip()
    if not ln:
        return
    # A later non-empty Pi event proves that the previous final-response candidate
    # was not the end of the turn, so the watchdog must keep waiting.
    with _LOCK:
        run = _RUNS.get(ref)
        if run is None:
            return
        if str(run.get("cli") or "") == "pi":
            run.pop("piFinalResponseAt", None)
    external = _EXTERNAL_DIR.search(ln)
    if external:
        blocked = str(external.group(1) or "").rstrip("*").rstrip("\\/")[:700]
        with _LOCK:
            run = _RUNS.get(ref)
            if run is not None:
                run["failureKind"] = "workspace_permission"
                run["failurePath"] = blocked
    new: list[dict] = []
    m = None
    if ln.startswith("{"):
        try:
            m = json.loads(ln)
        except Exception:  # noqa: BLE001
            m = None
        if m is None:
            new.append({"kind": "out", "tool": "", "text": ln[:300]})
        else:
            local_turn_outcome.observe(str(run.get("cli") or ""), m, term)
            event_type = str(m.get("type") or "").replace("-", "_").replace(".", "_")
            if (term.get("piFinalResponse") and event_type == "message_end"
                    and str(run.get("cli") or "") == "pi"):
                with _LOCK:
                    current = _RUNS.get(ref)
                    if current is not None:
                        current["piFinalResponseAt"] = time.time()
            context_error = local_context_policy.observe(run, m, term)
            if term.get("overflow") and context_error:
                with _LOCK:
                    _learn_window(run, context_error)
            # Claude result events carry terminal is_error and explanatory details.
            if m.get("type") == "result":
                term["isError"] = bool(m.get("is_error"))
                term["result"] = str(m.get("result") or "")
                # They also provide turn settlement fields such as usage, total_cost_usd, duration_ms, and num_turns.
                # Preserve those authoritative accounting fields.
                # They describe actual consumption and elapsed execution time.
                _accumulate_usage(run, m.get("usage") or {},
                                  cost=m.get("total_cost_usd"), turns=m.get("num_turns"))
            # Capture OpenCode sessionID and Codex thread_id from their output.
            # These runtimes assign their own session IDs.
            _sid = m.get("sessionID") or (
                m.get("thread_id") if str(m.get("type") or "") == "thread.started" else None)
            if _sid:
                fresh = False
                with _LOCK:
                    if not run.get("cliSid"):
                        run["cliSid"] = _sid
                        fresh = True
                if fresh:
                    # Persist cliSid immediately after discovery.
                    # Waiting until settlement could lose the resume key after a crash.
                    _save_meta(ref)
            err = m.get("error")
            if err:
                txt = json.dumps(err, ensure_ascii=False) if isinstance(err, dict) else str(err)
                term["isError"] = True
                term.setdefault("result", txt[:600])
                nm = str((err or {}).get("name") or "") if isinstance(err, dict) else ""
                if _OVERFLOW_PAT.search(txt) or "overflow" in nm.lower():
                    term["overflow"] = True
                    with _LOCK:
                        _learn_window(run, txt)
                new.append({"kind": "out", "tool": "错误", "text": txt[:400]})
            # Emit a progress heartbeat for step_start even when it has no display text.
            # Model reasoning can otherwise leave the console blank for an extended period.
            # Show which execution step is active.
            # Pi uses turn_start and Codex uses turn.started for the corresponding event.
            # Emit the same heartbeat for those runtimes.
            if str(m.get("type") or "").replace("-", "_").replace(".", "_") in (
                    "step_start", "turn_start", "turn_started"):
                with _LOCK:
                    run["steps"] = int(run.get("steps") or 0) + 1
                    nstep = run["steps"]
                new.append({"kind": "step", "tool": "", "text": f"第 {nstep} 步 · 正在想…"})
            # Completion and context measurement have different scopes.
            normalized_type = str(m.get("type") or "").replace("-", "_").replace(".", "_")
            if normalized_type == "turn_completed":
                term["completed"] = True
                with _LOCK:
                    current = _RUNS.get(ref)
                    if current is not None:
                        current["turnCompleted"] = True
            with _LOCK:
                local_context_policy.update_usage(run, m)
            from .runtime_messages import billed_event
            billed, scope = billed_event(m)
            if billed is not None and m.get("type") != "result":
                _accumulate_usage(run, billed, step=True)
            from . import runtime_messages
            new.extend(runtime_messages.augment(m, run, _items_from(m, run)))
    else:
        # Retain non-JSON CLI diagnostics rather than discarding them.
        # Only suppress explicitly recognized expected noise from activity display.
        # The raw diagnostic record still retains that noise.
        if _OVERFLOW_PAT.search(ln) and (stream == "err" or re.search(r"error|failed|错误|超限", ln, re.I)):
            term["overflow"] = True
            with _LOCK:
                _learn_window(run, ln)
        if not _EXPECTED_NOISE.search(ln):
            new.append({"kind": "out", "tool": "stderr" if stream == "err" else "",
                        "text": ln[:400]})
    from . import local_execution_policy
    new += local_execution_policy.enforce(ref, m, new, _kill_tree)
    from . import execution_event_policy
    execution_event_policy.tag_source_ids(m, new)
    if not new:
        return
    at = _now_iso()
    with _LOCK:
        run = _RUNS.get(ref)
        if run is None:
            return
        new = execution_event_policy.filter_new(run, new)
        if not new:
            return
        seq = int(run.get("seq") or 0)
        stamped = []
        for it in new:
            seq += 1
            it["seq"] = seq
            it["at"] = at
            it["seg"] = run.get("segment", 1)
            from . import turn_correlation
            turn_correlation.stamp(run, it)
            if stream_end:
                it["_stream"] = stream
                it["_streamEnd"] = int(stream_end)
            stamped.append(it)
        if stamped and term != terminal_before:
            stamped[-1]["_terminal"] = dict(term)
        run["seq"] = seq
        run["lines"] = (run.get("lines") or []) + stamped
        del run["lines"][:-_MEM_LINES]
        due = time.time() - float(run.get("metaAt") or 0) > 3
        if due:
            run["metaAt"] = time.time()
    _append_events(ref, stamped)
    # Persist runtime metadata with throttling so restart recovery includes recent progress and occupancy.
    if due:
        _save_meta(ref)









_AUTO_ANSWER = (
    "（这条是 SoduWork 自动回的：派活是无人值守的，现在没有人能回答你的问题。）\n"
    "**请你自己拿主意，把这件事做完。** 具体要求：\n"
    "1. 刚才问的那些，按最合理、最保守的做法自己定下来，别再问；\n"
    "2. 把你定的每个假设写清楚（选了什么、为什么），写在交付说明里；\n"
    "3. 确实卡死做不下去的部分，用「还需要人处理」起头列清楚，其余照做完；\n"
    "4. 结尾给**可交付的结果**（做了什么、东西在哪），不要再以问句结尾。"
)

# Detect clarification requests conservatively.
# A false positive spends another turn; a missed request remains available for human follow-up.
_ASK_TAIL = re.compile(
    r"(请确认|请问|是否需要|是否继续|要不要|需要我|您(希望|想要|打算)|你(希望|想要|打算)|"
    r"哪一种|哪个方案|确认一下|告诉我你|等你回复|请指示)")


def _ends_with_question(run: dict) -> bool:
    from .local_dialogue_outcome import current_rows
    says = [it for it in current_rows(run) if it.get("kind") == "say" and it.get("text")]
    if not says:
        return False
    tail = str(says[-1]["text"]).strip()
    if not tail:
        return False
    # Check for a trailing question or explicit request for user input in the final paragraph.
    return tail.endswith(("?", "？")) or bool(_ASK_TAIL.search(tail[-300:]))


def _scrub_runtime_config(ref: str) -> None:
    """Drop per-dispatch credentials as soon as no process needs them.

    The durable run record never contains ``cfg``; this also removes the in-memory
    credential copy, retaining only non-secret transport identity. A later human
    follow-up receives a freshly authorized config from Hub.
    """
    with _LOCK:
        run = _RUNS.get(ref)
        if run is not None:
            from . import codex_account_acp
            run["cfg"] = codex_account_acp.retained_config(run)


def _finish(ref: str, code: int, term: dict, hard_err: str) -> None:
    from . import access_transition, local_dialogue_outcome
    if access_transition.finish(ref, code, hard_err):
        return
    nxt = None
    auto_answered = False
    retry_stall = False
    completion_retried = False
    completion_recovery = {}
    with _LOCK:
        run = _RUNS.get(ref)
        if run is None:
            return
        # Settlement may be invoked by both stream EOF and the process watchdog.
        # The first invocation owns settlement; later calls must return.
        # This prevents terminal-state rewrites and duplicate artifact collection.
        if run.get("state") != "running":
            return
        run["proc"] = None
        run["exit"] = code
        run["ended"] = time.time()
        timed = run.pop("timedOut", "")
        stopping = run.get("stopping")
        overflow = bool(term.get("overflow"))
        # Check terminal event failures as well as the process exit code.
        # Some CLIs return zero after authentication errors while marking the result as failed.
        # Do not misreport such failures as successful executions without outputs.
        # Pi can emit its final answer and leave the print process alive. The
        # process watchdog marks its deliberate cleanup kill; only that current,
        # successful Pi response may tolerate the resulting nonzero exit.
        watchdog_cleanup = bool(run.pop("piSettledByWatchdog", False))
        pi_settled = (watchdog_cleanup and run.get("cli") == "pi"
                      and run.get("piFinalResponseAt") and term.get("piFinalResponse")
                      and not (timed or stopping or overflow or term.get("outputTruncated")
                               or run.get("permissionDenied") or run.get("executionPolicyViolation")))
        bad = (code != 0 and not pi_settled) or term.get("isError") or hard_err
    if stopping and not timed:
        with _LOCK:
            violation = dict(run.get("executionPolicyViolation") or {})
            run["state"] = "failed" if violation else "stopped"
            run["error"] = str(violation.get("reason") or "你把它叫停了")
            if violation:
                run["failureKind"] = "execution_policy"
            run["stopping"] = False
        _save_meta(ref)
        _scrub_runtime_config(ref)
        return
    # On context exhaustion, try compaction before handoff; neither transition is an execution failure.
    if overflow and not stopping and not run.get("permissionDenied"):
        from .local_ctx import _recover_overflow     # Defer the import because stream and context modules depend on each other.
        if _recover_overflow(ref):
            return
    if not timed and not stopping and not bad and not run.get("permissionDenied"):
        from . import local_completion
        completion_recovery = local_turn_outcome.recovery(run, term)
        if not term.get("outputTruncated"):
            completion_recovery = local_completion.assess(run)
    truncated = bool(term.get("outputTruncated"))
    dialogue_failure = local_dialogue_outcome.failure(run, term) if not bad and not truncated else {}
    bad = bad or (truncated and not completion_recovery) or bool(dialogue_failure)
    if dialogue_failure:
        completion_recovery = {}
    with _LOCK:
        if timed:
            retried = int(run.get("stallRetries") or 0)
            retry_stall = not stopping and not run.get("permissionDenied") and retried < _STALL_RETRY_LIMIT
            run["failureKind"] = "execution_stalled"
            if retry_stall:
                run["stallRetries"] = retried + 1
                run["state"] = "recovering"
                run["error"] = "执行静默超时，SoduWork 正在自动续跑一次"
            else:
                run["state"] = "failed"
                run["error"] = ("它" + timed + "，自动恢复次数已经用完。已经跑出来的东西仍在工作目录，"
                                "请查看最后一条实况后重试。")
        else:
            run["state"] = "failed" if bad else "done"
            if truncated and bad:
                run["failureKind"] = "execution_incomplete"
                run["error"] = local_turn_outcome.TRUNCATED
            elif dialogue_failure:
                run["failureKind"] = dialogue_failure["kind"]
                run["error"] = dialogue_failure["reason"]
            elif bad and run.get("failureKind") == "workspace_permission":
                path = str(run.get("failurePath") or "所需工程目录")
                run["error"] = (
                    "本轮从临时目录启动，但工作需要访问工程目录 %s。"
                    "SoduWork 已阻止跨越未绑定目录；请选择对应工程后重试。" % path)
            else:
                # Claude's successful `result` carries its final answer. It is
                # not an error: publishing it here makes a completed resumed
                # turn look like a provider failure to every Runner client.
                run["error"] = _friendly(hard_err or term.get("result") or
                    (f"执行进程异常退出（退出码 {code}）" if code else "执行未能完成，请查看最后一条实况。")) if bad else ""
                if not bad:
                    run.pop("failureKind", None)
                    run.pop("failurePath", None)
        run["stopping"] = False
        # Apply at most one automatic continuation after a clarification request.
        # Queued human messages take precedence over an automatic answer.
        if run["state"] == "done" and not run.get("queue") and completion_recovery:
            run["completionRetries"] = int(run.get("completionRetries") or 0) + 1
            run["queue"] = [str(completion_recovery.get("prompt") or "")]
            completion_retried = True
        elif (run["state"] == "done" and not run.get("queue")
                and not local_dialogue_outcome.interactive(run)
                and not run.get("permissionDenied")
                and not run.get("autoAnswered") and _ends_with_question(run)
                and (not run.get("recoveredOutput") or run.get("cfg"))):
            run["autoAnswered"] = True
            run["queue"] = [_AUTO_ANSWER]
            auto_answered = True
        # Continue queued user messages after the current turn settles.
        if run["state"] == "done" and run.get("queue"):
            nxt = run["queue"].pop(0)
            # Pollers must not observe "done" between two segments of one node.
            run["state"] = "recovering"
        cfg = run.get("cfg") or {}
        _record_terminal(ref, run)
        # Commit terminal state before pollers can observe it and restart the Runner.
        # Slow delivery inspection below must not leave a completed turn running on disk.
        _save_meta(ref)
    if retry_stall:
        # A Runner restart deliberately restores no secret from disk.  The active
        # desktop normally re-authorizes within the next poll; if it is offline,
        # do not turn that security boundary into the misleading "never configured"
        # error emitted by _env_for.  Preserve the work and tell the user how to resume.
        if authorization_required_sync(ref):
            with _LOCK:
                pending = _RUNS.get(ref)
                if pending is not None:
                    pending["state"] = "failed"
                    pending["failureKind"] = "model_reauthorization"
                    pending["error"] = (
                        "执行机在本轮中途重启，模型临时授权未能及时恢复。"
                        "工作区和已经完成的进度均已保留；请在当前会话中发送“继续”，"
                        "SoduWork 会重新授权并从现有进度接上。")
            _save_meta(ref)
            _scrub_runtime_config(ref)
            return
        from .local_ctx import _note
        _note(ref, "（SoduWork 自动恢复）本轮长时间没有新输出，已安全收掉并从同一会话继续；"
                   "只自动重试这一次，避免无限循环。")
        _save_meta(ref)
        resumed = _resume(ref, _STALL_RECOVERY_PROMPT, cfg)
        if resumed.get("ok"):
            log.warning("本地会话 %s 静默超时，已自动续跑（第 %s 次）", ref[:8],
                        (_RUNS.get(ref) or {}).get("stallRetries"))
            return
        with _LOCK:
            failed = _RUNS.get(ref)
            if failed is not None:
                failed["state"] = "failed"
                failed["failureKind"] = "execution_stalled"
                failed["error"] = "静默超时后自动续跑没有启动：" + str(resumed.get("error") or "未知原因")
        _save_meta(ref)
        _scrub_runtime_config(ref)
        return
    if auto_answered:
        # Record automatic answers as system activity.
        # Preserve the fact that SoduWork supplied an assumption rather than hiding the intervention.
        from .local_ctx import _note      # Defer imports because stream and context modules depend on each other.
        _note(ref, "（SoduWork 自动接管）它这一轮是拿问题收的尾。派活是无人值守的，"
                   "已经替你回了「你自己定、把假设写清楚、把活做完」，让它接着跑。"
                   "只会自动推这一次；要是它还卡着，就得你自己去看一眼了。")
        log.info("本地会话 %s：它反问了，自动替人答一句让它做完", ref[:8])
    if completion_retried:
        from .local_ctx import _note
        _note(ref, completion_recovery.get("note") or
                   "（SoduWork 自动恢复）检测到工具调用异常且 Git 工作区仍有未提交修改，"
                   "已保留当前进度并让同一会话继续完成提交与推送；自动恢复只执行一次。")
        log.warning("本地会话 %s 未完成，已保留进度自动续跑", ref[:8])
    if not nxt:
        # Capture the repository identity at process completion, before another
        # task or a later resumed turn can move the shared working copy.
        from .ai_local import _git_delivery
        _git_delivery(run)
        _scrub_runtime_config(ref)
    _save_meta(ref)
    if nxt:
        if not auto_answered and not completion_retried:
            with _LOCK:
                run.pop("_accessSessionDenials", None)
        log.info("本地会话 %s：接着说排队的那句", ref[:8])
        resumed = _resume(ref, nxt, cfg)
        if not resumed.get("ok"):
            _scrub_runtime_config(ref)
            if nxt:
                with _LOCK:
                    failed = _RUNS.get(ref)
                    if failed is not None:
                        failed["state"] = "failed"
                        failed["failureKind"] = "execution_incomplete"
                        failed["error"] = "保留进度后续跑没有启动：" + str(
                            resumed.get("error") or "未知原因")
                _save_meta(ref)
