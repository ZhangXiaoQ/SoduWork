"""Run an explicitly dispatched task through server-side OpenCode and attach outputs to the task.
Record agent.started, agent.done, and agent.failed timeline events and notify the responsible
device; do not overwrite human-maintained task.progress. Reuse configured model settings, pass
credentials only through the child environment, and retain the ignored task workspace for
inspection. Conservative defaults permit output edits while denying shell execution and web
fetching for untrusted task text. Remove inherited proxy variables and add the configured model
host to NO_PROXY for direct provider access."""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import time
import uuid
from datetime import datetime
from urllib.parse import urlparse

from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..db import SessionLocal
from ..realtime import hub
from . import llm, storage, task_events

log = logging.getLogger("uvicorn.error")

# hub-backend/workspaces/
_WS_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "workspaces")

_RUNNING: dict[str, float] = {}          # Track active task IDs and monotonic start times to prevent duplicate execution.
_TASKS: set = set()                       # Retain strong references to background asyncio tasks.
_MAX_CONCURRENT = 2                       # Concurrent execution limit.
_START_LOCK = asyncio.Lock()              # Keep the slot-capacity check and registration atomic across the llm.load await.
_TIMEOUT_S = 600                          # Hard execution timeout.
_MAX_FILES = 10                           # Maximum number of outputs.
_MAX_FILE_MB = 5                          # Maximum file size.

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def is_running(task_id: str) -> bool:
    return task_id in _RUNNING


def _opencode_bin() -> str | None:
    """Resolve the executable directly, avoiding Windows command shims that can alter arguments.
    Pass the prompt through stdin.
    """
    npm_root = os.path.join(os.environ.get("APPDATA", ""), "npm", "node_modules", "opencode-ai")
    for rel in ("bin/opencode.exe",
                "node_modules/opencode-windows-x64/bin/opencode.exe",
                "node_modules/opencode-windows-x64-baseline/bin/opencode.exe"):
        p = os.path.join(npm_root, *rel.split("/"))
        if os.path.isfile(p):
            return p
    p = shutil.which("opencode.exe") or shutil.which("opencode")
    if p and p.lower().endswith((".ps1", ".cmd")):
        return None                      # Treat a shim without its executable as unavailable.
    return p


def _compose_prompt(t: models.Task) -> str:
    """Build self-contained one-shot instructions that follow the request's output language and
    require no clarification.
    """
    lines = [
        "你在替同事完成一项工作任务，请直接完成并把可交付的产出写成文件，不要向任何人提问。",
        "",
        f"任务标题：{t.title}",
    ]
    if (t.note or "").strip():
        lines.append(f"任务描述：{t.note.strip()}")
    pr = getattr(t, "priority", "") or ""
    if pr and pr != "normal":
        lines.append(f"优先级：{pr}")
    if getattr(t, "due_at", None):
        lines.append(f"截止：{t.due_at:%Y-%m-%d}")
    tags = list(getattr(t, "tags", None) or [])
    if tags:
        lines.append("标签：" + "、".join(str(x) for x in tags))
    prog = [p for p in (getattr(t, "progress", None) or []) if isinstance(p, dict) and (p.get("text") or "").strip()]
    if prog:
        lines.append("已有进展（人写的记录，供你衔接上下文）：")
        for p in prog[-5:]:
            who = p.get("byName") or ""
            lines.append(f"  - {(who + '：') if who else ''}{p['text'].strip()}")
    lines += [
        "",
        "交付要求：",
        "1. 主产出写进 `结果.md`（Markdown，用任务描述的语言写），第一行用一句话说清你完成了什么。",
        "2. 如需多个文件（方案/清单/代码样例等）就分文件写，文件名用中文或清晰英文。",
        "3. 你没有执行命令和联网的权限，仅凭任务信息与你的知识完成；信息不足就基于合理假设完成并在结果里注明假设。",
        # Return URL deliverables through the agreed manifest.
        # agent_runner reads artifact_url for review.
        "4. 如果这个任务的交付物**不适合以文件形式给出**（例如要的是一个能访问的网站/服务/页面），"
        "把最终可访问的地址单独写进 `产出地址.txt`（只写一行 URL，不要别的内容），"
        "同时 `结果.md` 里说明这个地址是什么、怎么用。",
        "5. 全部写完即结束，不要输出与产出无关的客套话。",
    ]
    return "\n".join(lines)


def _run_opencode(ws: str, prompt: str, base: str, key: str, model: str) -> tuple[int, str, float]:
    """Run OpenCode synchronously in a worker; return exit code, sanitized output, and elapsed
    seconds.
    """
    import json as _json

    oc = _opencode_bin()
    if not oc:
        raise RuntimeError("服务器未安装 opencode（npm i -g opencode-ai）")
    cfg = {
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            "company": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "公司模型服务",
                "options": {"baseURL": base, "apiKey": "{env:SODUWORK_LLM_KEY}"},
                "models": {model: {"name": "公司 coding 模型"}},
            }
        },
        "model": f"company/{model}",
        "permission": {"edit": "allow", "bash": "deny", "webfetch": "deny"},
    }
    with open(os.path.join(ws, "opencode.json"), "w", encoding="utf-8") as f:
        f.write(_json.dumps(cfg, ensure_ascii=False, indent=2))

    env = dict(os.environ)
    env["SODUWORK_LLM_KEY"] = key
    host = urlparse(base).hostname or ""
    env["NO_PROXY"] = (host + "," + env.get("NO_PROXY", "")).strip(",")
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
              "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"):
        env.pop(k, None)

    t0 = time.monotonic()
    # Pass the prompt through stdin to avoid Windows multiline argument handling.
    p = subprocess.run(
        [oc, "run"], input=prompt, cwd=ws, env=env,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=_TIMEOUT_S,
    )
    dur = time.monotonic() - t0
    out = _ANSI.sub("", (p.stdout or "") + ("\n" + p.stderr if p.stderr else ""))
    return p.returncode, out.strip(), dur


def _summary_of(out: str, limit: int = 420) -> str:
    """Summarize the final nonempty lines, excluding tool output where possible."""
    lines = [ln.strip() for ln in out.splitlines()]
    lines = [ln for ln in lines if ln and not ln.startswith(("←", ">", "|")) and "Wrote file" not in ln]
    s = " ".join(lines[-6:])
    return (s[: limit - 1] + "…") if len(s) > limit else s


_URL_FILE = "产出地址.txt"


def _read_artifact_url(ws: str) -> str:
    """Read the URL manifest and accept only HTTP or HTTPS URLs."""
    fp = os.path.join(ws, _URL_FILE)
    if not os.path.isfile(fp):
        return ""
    try:
        # Explicit context manager: rely on GC to close the handle (the previous
        # bare open().read()) can keep the file locked on Windows until the next
        # collection cycle.
        with open(fp, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
        for ln in lines:
            u = ln.strip()
            if u.startswith(("http://", "https://")):
                return u[:600]
    except Exception:  # noqa: BLE001
        pass
    return ""


def _collect_files_sync(ws: str, task_id: str) -> list[dict]:
    """Scan, read, and upload artifact metadata in a worker thread, excluding opencode.json, so
    file and network I/O do not block the event loop.
    """
    got: list[dict] = []
    for root, _dirs, names in os.walk(ws):
        if len(got) >= _MAX_FILES:
            break
        for fn in names:
            if fn == "opencode.json" or len(got) >= _MAX_FILES:
                continue
            fp = os.path.join(root, fn)
            try:
                size = os.path.getsize(fp)
            except OSError:
                continue
            if size == 0 or size > _MAX_FILE_MB * 1024 * 1024:
                continue
            try:
                with open(fp, "rb") as f:
                    data = f.read()
            except OSError:
                continue
            ctype = mimetypes.guess_type(fn)[0] or "application/octet-stream"
            key = f"agent/{task_id}/{uuid.uuid4().hex[:8]}-{fn}"
            backend = storage.put(key, data, ctype)
            got.append({"filename": fn, "content_type": ctype, "size": size,
                        "storage_key": key, "backend": backend})
    return got


async def _collect_files(session: AsyncSession, task_id: str, ws: str) -> list[str]:
    """Import workspace files as attachments, excluding opencode.json, and return their names."""
    rows = await asyncio.to_thread(_collect_files_sync, ws, task_id)
    for row in rows:
        session.add(models.Attachment(
            task_id=task_id, filename=row["filename"], content_type=row["content_type"],
            size=row["size"], storage_key=row["storage_key"], backend=row["backend"],
            uploaded_by="agent:SoduWork", role="output",
            source_ref="agent-runner:" + task_id,
        ))
    return [row["filename"] for row in rows]


async def start(session: AsyncSession, t: models.Task, actor_name: str) -> dict:
    """Validate and record execution; the caller commits before starting background work."""
    from .task_requirements import ensure_executable
    ensure_executable(t)
    from .cluster_bus import bus
    if bus.enabled:
        raise ValueError("多实例模式不在后台进程直接运行 Agent，请通过任务派活选择 Runner")
    # The capacity check and slot registration must be atomic: llm.load() awaits
    # in between, and without the lock two concurrent starts could both pass the
    # check and overshoot _MAX_CONCURRENT. Holding the lock across llm.load is
    # acceptable because start() is a low-frequency, user-initiated operation.
    async with _START_LOCK:
        if is_running(t.id):
            raise ValueError("这个任务已有一轮 SoduWork 执行在进行中")
        if len(_RUNNING) >= _MAX_CONCURRENT:
            raise ValueError(f"执行槽已满（同时最多 {_MAX_CONCURRENT} 个），稍后再试")
        cfg = await llm.load(session, force=True)
        if not llm.enabled(cfg):
            raise ValueError("模型服务未配置（管理端→集成源→模型服务）")
        if not _opencode_bin():
            raise ValueError("服务器未安装 opencode（npm i -g opencode-ai）")

        task_events.record(session, t.id, "agent.started", {"by": actor_name}, actor=actor_name)
        _RUNNING[t.id] = time.monotonic()
    # Spawn outside the lock: no await happens between unlock and task creation,
    # so no other start() can slip in before the background task takes over.
    bg = asyncio.get_running_loop().create_task(_run_bg(
        t.id, t.title, t.owner_client_id or "",
        cfg["llm_base_url"], cfg["llm_api_key"], cfg.get("llm_model", ""), actor_name,
    ))
    _TASKS.add(bg)
    bg.add_done_callback(_TASKS.discard)
    return {"ok": True, "started": True}


async def _run_bg(task_id: str, title: str, owner_box: str,
                  base: str, key: str, model: str, actor_name: str) -> None:
    """Use an independent background session and always record termination and release capacity."""
    ws = os.path.join(_WS_ROOT, f"{task_id}_{datetime.now():%H%M%S}")
    status, summary, files, dur, artifact_url = "agent.failed", "", [], 0.0, ""
    log.info("agent run start task=%s ws=%s", task_id, ws)
    try:
        # Directory creation must stay inside the try: the _RUNNING slot was
        # already claimed in start(), so a failure here (disk full, permission
        # denied) has to flow through finally to release the slot. Outside the
        # try, two such failures would permanently exhaust background execution.
        os.makedirs(ws, exist_ok=True)
        async with SessionLocal() as s:
            t = await s.get(models.Task, task_id)
            if t is None:
                raise RuntimeError("任务已不存在")
            prompt = _compose_prompt(t)
        rc, out, dur = await asyncio.to_thread(_run_opencode, ws, prompt, base, key, model)
        artifact_url = _read_artifact_url(ws)
        async with SessionLocal() as s:
            files = await _collect_files(s, task_id, ws)
            if artifact_url:
                t2 = await s.get(models.Task, task_id)
                if t2 is not None:
                    t2.artifact_url = artifact_url
            await s.commit()
        if rc == 0 and files:
            status, summary = "agent.done", _summary_of(out)
        else:
            summary = _summary_of(out) or f"opencode 退出码 {rc}"
            if rc == 0 and not files:
                summary = "执行完成但没有产出文件——" + summary
    except subprocess.TimeoutExpired:
        summary = f"超时（{_TIMEOUT_S}s）已终止"
    except Exception as e:  # noqa: BLE001 - Report a safe exception type and message without internal details.
        summary = f"{type(e).__name__}: {e}"
        log.warning("agent run failed task=%s err=%s", task_id, type(e).__name__)
    finally:
        _RUNNING.pop(task_id, None)
        log.info("agent run end task=%s status=%s files=%d dur=%.1fs", task_id, status, len(files), dur)
        try:
            creator_box = ""
            async with SessionLocal() as s:
                task_events.record(s, task_id, status, {
                    "summary": summary, "files": files, "seconds": round(dur, 1),
                    "by": actor_name, "artifactUrl": artifact_url,
                }, actor="agent:SoduWork")
                await s.commit()

                # Notify the reviewer so they can inspect the delivered artifacts and approve the result.
                t3 = await s.get(models.Task, task_id)
                cid = getattr(t3, "created_by", None) if t3 is not None else None
                if cid:
                    from sqlalchemy import select as _sel
                    creator_box = (await s.execute(
                        _sel(models.Client.id).where(models.Client.user_ref == cid).limit(1)
                    )).scalar() or ""
            ok = status == "agent.done"
            if ok:
                what = artifact_url or (f"{len(files)} 个产出已挂到任务附件" if files else "已完成")
                text = f"🤖 SoduWork 完成了「{title}」：{what}" + ("（可在任务详情里审核）" if artifact_url or files else "")
            else:
                text = f"🤖 SoduWork 执行「{title}」没成功：{summary[:80]}"
            for box in {b for b in (owner_box, creator_box) if b}:
                await hub.publish(box, {"type": "notice", "text": text, "taskId": task_id})
        except Exception:  # noqa: BLE001 - Log cleanup failures without raising them.
            log.exception("agent run finalize failed task=%s", task_id)
