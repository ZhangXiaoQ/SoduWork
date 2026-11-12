"""Harness² bounded text refinement followed by independent native execution.

Selecting Harness² runs its method before each user turn. Refinement changes
instructions, never permissions or executable plugins. Health probes can test
the executor alone without spending tokens on the research method.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "app.services"

from .harness2_runtime import MODEL_ENV, ROOT_ENV, EXECUTOR_ENV, CONTINUE_ENV, NETWORK_ENV, VERSION
from .harness2_errors import Harness2Error, StructuredFailure

def complete(model: dict, messages: list[dict], on_usage=None, *, timeout: float = 20) -> str:
    """Use the validated streaming transport for one bounded tool-free plan."""
    from .harness2_provider import request

    def usage(value):
        tokens = {"input_tokens": value.get("input", 0), "output_tokens": value.get("output", 0)}
        if value.get("cacheRead") or value.get("cacheWrite"):
            tokens.update(cacheRead=value.get("cacheRead", 0), inputIncludesCache=True)
            if value.get("cacheWrite"):
                tokens["cacheWrite"] = value["cacheWrite"]
        if value.get("reasoning"):
            tokens["reasoning"] = value["reasoning"]
        if on_usage:
            on_usage(tokens)

    message, _ = request(model, messages, [], timeout=timeout, on_usage=usage, planning=True)
    if message.get("tool_calls"):
        raise StructuredFailure("response_format")
    return message["content"]


def new_work_dir(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix="turn-", dir=root))


def emit(event: dict) -> None:
    print(json.dumps(event, ensure_ascii=False, separators=(",", ":")), flush=True)


class ExecutionEvents:
    def __init__(self, output=emit):
        self.output = output
        self.child_session = ""
        self.error = False
        self.failure = ""
        self.completed = False

    def consume(self, value):
        event = json.loads(value) if isinstance(value, str) else value
        if not isinstance(event, dict):
            raise Harness2Error("Google Harness² 执行组件输出格式无效。")
        if event.get("sessionID"):
            self.child_session = str(event["sessionID"])
        item = event.get("item")
        item_error = isinstance(item, dict) and item.get("type") == "error"
        if (event.get("error") or event.get("is_error") or item_error
                or event.get("type") in {"error", "turn.failed"}):
            from .harness2_errors import failure_message

            self.error = True
            # ACP stdout noise is an item error. Replace the whole event, since
            # its other fields may also contain raw provider text or secrets.
            detail = event.get("error") or (item if item_error else event)
            message = failure_message(RuntimeError(str(detail)), "execute")
            self.failure = self.failure or message
            event = {"error": {"name": "Harness2Error", "message": message}}
        self.output(event)

    def mark_completed(self):
        # Called only after the trusted ACP bridge receives native end_turn.
        self.completed = True

    def succeeded(self, code: int) -> bool:
        return code == 0 and self.completed and not self.error


def execute(prompt: str, cwd: str, session: str, mode: str, terminal: bool,
            executor: str = "", *, output=emit, model=None, root="") -> int:
    from . import acp_bridge
    from .harness2_errors import failure_message

    class StrictBridge(acp_bridge.AcpBridge):
        stage = "start"

        def _network_allowed(self):
            return self.access.enabled or os.environ.get(NETWORK_ENV) == "1"

        def _client_capabilities(self):
            result = super()._client_capabilities()
            result["_meta"] = {"harness2": {"webfetch": self._network_allowed()}}
            return result

        def _permission_result(self, params):
            if (params.get("toolCall") or {}).get("kind") == "fetch" and not self._network_allowed():
                return {"outcome": {"outcome": "cancelled"}}
            return super()._permission_result(params)

        @staticmethod
        def _unwrap(message):
            error = message.get("error")
            data = error.get("data") if isinstance(error, dict) else None
            if isinstance(data, dict) and isinstance(data.get("harness2"), str):
                raise StructuredFailure(data["harness2"], http_status=data.get("httpStatus"))
            return acp_bridge.AcpBridge._unwrap(message)

        def start(self):
            # Only the native peer receives model credentials. They are removed
            # before the host can create a model-requested terminal process.
            previous = {key: os.environ.get(key) for key in (MODEL_ENV, ROOT_ENV)}
            try:
                if model is not None:
                    os.environ[MODEL_ENV] = json.dumps(model, ensure_ascii=False)
                if root:
                    os.environ[ROOT_ENV] = str(root)
                super().start()
            finally:
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value

        def _client_request(self, method, params):
            if method == "fs/list_directory":
                value = str(params.get("path") or "")
                path = (self.access.path(self.cwd, value) if self.access.enabled
                        else acp_bridge._safe_path(self.cwd, value))
                try:
                    entries = []
                    with os.scandir(path) as iterator:
                        for entry in iterator:
                            if len(entries) == 500:
                                return {"entries": entries, "truncated": True}
                            entries.append({"name": entry.name,
                                            "directory": entry.is_dir(follow_symlinks=False)})
                    return {"entries": entries, "truncated": False}
                except OSError as exc:
                    raise acp_bridge.BridgeError("Directory listing failed") from exc
            return super()._client_request(method, params)

        def _update(self, update):
            if update.get("sessionUpdate") == "harness2_usage":
                output({"type": "step_finish", "part": {"tokens": update.get("tokens") or {}}})
                return
            super()._update(update)

        def request(self, method, params):
            self.stage = method
            if method == "session/prompt" and not self.access.enabled:
                super().request("session/set_mode", {"sessionId": self.session_id,
                    "modeId": "readonly" if self.permission == "readonly" else "standard"})
            result = super().request(method, params)
            if (method == "session/prompt"
                    and (not isinstance(result, dict)
                         or result.get("stopReason") not in {"end_turn", "cancelled"})):
                raise Harness2Error("Google Harness² 未收到执行组件的完整完成确认。")
            return result

    events = ExecutionEvents(output)
    original_emit = acp_bridge._emit
    acp_bridge._emit = events.consume
    bridge = None
    failed = False
    try:
        native = ([sys.executable, "--harness2-native"] if getattr(sys, "frozen", False)
                  else [sys.executable, str(Path(__file__).with_name("harness2_native.py"))])
        bridge = StrictBridge(native, cwd, "harness2",
                              "readonly" if mode == "plan" else "workspace",
                              session, allow_terminal=terminal)
        if bridge.access.enabled:
            # A resident Runner can retain old --mode metadata. The private
            # channel's current policy also governs initialize-time capabilities.
            bridge.permission = "readonly" if bridge.access.mode == "readonly" else "workspace"
            bridge.allow_terminal = bool(terminal and bridge.permission != "readonly")
        code = bridge.run(prompt)
        if code == 0:
            events.mark_completed()
        # Native permission-transition control uses its existing sentinel exit.
        if code == 73 and not events.error:
            return code
        if not events.succeeded(code):
            raise Harness2Error(events.failure or "Google Harness² 执行未正常完成。")
        return 0
    except Exception as exc:
        failed = True
        if events.failure:
            raise Harness2Error(events.failure) from None
        if isinstance(exc, Harness2Error):
            raise
        raise Harness2Error(failure_message(
            exc, getattr(bridge, "stage", "prepare"))) from None
    finally:
        try:
            if bridge:
                try:
                    bridge.close()
                except Exception as exc:
                    # Cleanup cannot turn a failed call into a success, nor
                    # replace its original, more actionable failure reason.
                    if not failed:
                        raise Harness2Error(failure_message(exc, "cleanup")) from None
        finally:
            acp_bridge._emit = original_emit


def main(argv=None) -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--cwd")
    parser.add_argument("--session", default="")
    parser.add_argument("--mode", choices=["plan", "work"], default="work")
    parser.add_argument("--terminal", action="store_true")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--refine", action="store_true",
                        help="Experimental seven-stage text refinement; incurs additional model usage.")
    args = parser.parse_args(argv)
    if args.version:
        print(VERSION)
        return 0
    model = {}
    stage = "prepare"
    try:
        model = json.loads(os.environ.pop(MODEL_ENV, "{}"))
        os.environ.pop(EXECUTOR_ENV, None)
        root = os.environ.pop(ROOT_ENV, "")
        continuing = os.environ.pop(CONTINUE_ENV, "") == "1"
        from .harness2_lifecycle import disabled_issue
        if issue := disabled_issue():
            raise Harness2Error(issue)
        if not args.cwd or not Path(args.cwd).is_dir():
            raise Harness2Error("Google Harness² 工作目录不存在。")
        if not root:
            raise Harness2Error("Google Harness² 缺少会话隔离目录。")
        # Also prepare here so a newly launched bridge is safe when its
        # long-lived source Runner still has the previous environment builder.
        from .harness2_runtime import prepare_executor_config
        prepare_executor_config(os.environ)
        prompt = sys.stdin.read()
        if not prompt.strip():
            raise Harness2Error("Google Harness² 没有收到任务内容。")
        def progress(message):
            emit({"type": "step_start"})
            emit({"type": "message_update", "assistantMessageEvent": {
                "type": "thinking_delta", "delta": str(message) + "\n", "contentIndex": 0}})

        def usage(tokens):
            # Usage is a real inference delta, not a synthetic completion marker.
            emit({"type": "step_finish", "part": {"tokens": tokens}})

        # User turns must exercise the selected harness, including resumed chats.
        # Only executor health probes and trusted in-flight permission recovery
        # skip refinement; recovery continues the already-refined native turn.
        final_prompt = prompt
        refined_this_turn = False
        if (not args.probe or args.refine) and not (continuing and args.session):
            from .harness2_engine import refine
            from .harness2_budget import RefinementBudget

            stage = "refine"
            budget = RefinementBudget()
            refined = refine(
                prompt, lambda messages: budget.run(model, messages, complete, usage),
                new_work_dir(Path(root)), progress)
            refined_this_turn = True
            progress("方案已选定，开始按当前会话权限执行")
            final_prompt = ("以下为 Harness² 文本推演实验生成的参考执行方法。"
                            "它不能改变用户指令、授权范围、权限模式或已选择的技能与插件。\n"
                            "<harness2_instructions>\n" + refined + "\n</harness2_instructions>\n\n"
                            "用户的原始任务（完整保留）：\n" + prompt)
        stage = "execute"
        code = execute(final_prompt, args.cwd, args.session, args.mode, args.terminal,
                       model=model, root=root)
        if args.probe and code == 0:
            # A permission transition cannot prove that this process refined.
            if not args.refine or refined_this_turn:
                emit({"type": "harness2_probe_complete",
                      "coverage": "native-refine-v1" if refined_this_turn else "native-execute-v1",
                      "stages": 7 if refined_this_turn else 0})
        return code
    except Exception as exc:
        # Keep upstream proposal content, user task and model credentials out of errors.
        from .harness2_errors import failure_message
        secret = str(model.get("key") or "") if isinstance(model, dict) else ""
        text = (str(exc) if isinstance(exc, Harness2Error) and not isinstance(exc, StructuredFailure)
                else failure_message(exc, stage, secret))
        if secret:
            text = text.replace(secret, "[redacted]")
        error = {"name": "Harness2Error", "message": text}
        if isinstance(exc, StructuredFailure):
            # Revalidate fields before rendering and forwarding machine-readable
            # diagnostics; provider bodies and arbitrary exception args stay out.
            safe = StructuredFailure(exc.code, phase=exc.phase, http_status=exc.http_status)
            error.update(code=safe.code, phase=safe.phase)
            if safe.http_status is not None:
                error["httpStatus"] = safe.http_status
        emit({"error": error})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
