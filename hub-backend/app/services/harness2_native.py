"""Independent Harness² executor speaking ACP to the existing trusted host.

No external agent CLI participates. The host owns file/terminal permission and
process cleanup; this process owns model/tool iteration and its native transcript.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import sys
import threading
import uuid

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    __package__ = "app.services"

from .harness2_runtime import MODEL_ENV, ROOT_ENV, EXECUTOR_PROMPT
from .harness2_provider import request
from .harness2_session import Session
from .harness2_tools import Tools
from .harness2_errors import failure_message, StructuredFailure

MAX_LINE = 32 * 1024 * 1024
MAX_CALLS = 100
MAX_ROUNDS = 40


class Cancelled(Exception):
    pass


class Peer:
    def __init__(self, model, root, servers, output=None):
        self.model, self.root = model, root
        self.output = output or self._stdout
        self.output_lock = threading.Lock()
        self.cancel = threading.Event()
        self.responses = {}
        self.responses_lock = threading.Lock()
        self.session = None
        self.mode = "readonly"
        self.capabilities = {}
        self.worker = None
        self.tools = Tools(self, servers)

    @staticmethod
    def _stdout(value):
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)

    def send(self, value):
        with self.output_lock:
            self.output(value)

    def reply(self, request_id, result=None, error=None, diagnosis=None):
        self.send({"jsonrpc": "2.0", "id": request_id,
                   **({"error": {"code": -32000, "message": error,
                                 **({"data": {"harness2": diagnosis.code,
                                             "httpStatus": diagnosis.http_status}} if diagnosis else {})}} if error
                      else {"result": result or {}})})

    def update(self, update):
        self.send({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": self.session.id, "update": update}})

    def host(self, method, params, *, allow_cancel=False):
        if self.cancel.is_set() and not allow_cancel:
            raise Cancelled
        request_id = "h2:" + uuid.uuid4().hex
        box = queue.Queue(maxsize=1)
        with self.responses_lock:
            self.responses[request_id] = box
        try:
            self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            while True:
                try:
                    result = box.get(timeout=.1)
                    break
                except queue.Empty:
                    if self.cancel.is_set() and not allow_cancel:
                        raise Cancelled
            if result.get("error"):
                raise ValueError(str(result["error"].get("message") or "Host operation failed"))
            return result.get("result") or {}
        finally:
            with self.responses_lock:
                self.responses.pop(request_id, None)

    def receive(self, value):
        if "method" not in value:
            with self.responses_lock:
                box = self.responses.get(value.get("id"))
                if box and box.empty():
                    box.put_nowait(value)
            return
        method, params, rid = value["method"], value.get("params") or {}, value.get("id")
        if method == "session/cancel":
            if self.session and params.get("sessionId") == self.session.id:
                self.cancel.set()
            return
        try:
            if method == "initialize":
                self.capabilities = params.get("clientCapabilities") or {}
                self.reply(rid, {"protocolVersion": 1, "agentCapabilities": {
                    "loadSession": True, "promptCapabilities": {"image": True}}})
                return
            if self.worker and self.worker.is_alive():
                raise ValueError("A Harness² turn is already active")
            if method in {"session/new", "session/load"}:
                if self.session:
                    raise ValueError("Session already initialized")
                self.session = Session(self.root, params["cwd"], params.get("sessionId", ""))
                self.session.save()
                self.reply(rid, {"sessionId": self.session.id, "modes": {
                    "currentModeId": self.mode, "availableModes": [
                        {"id": mode, "name": mode} for mode in ("readonly", "standard", "full")]}})
                return
            if not self.session or params.get("sessionId") != self.session.id:
                raise ValueError("Session identity does not match")
            if method == "session/set_mode":
                if params.get("modeId") not in {"readonly", "standard", "full"}:
                    raise ValueError("Unsupported permission mode")
                self.mode = params["modeId"]
                self.reply(rid)
            elif method == "session/prompt":
                self.cancel = threading.Event()
                self.worker = threading.Thread(target=self.turn, args=(rid, params["prompt"]), daemon=True)
                self.worker.start()
            else:
                raise ValueError("Unsupported Harness² method")
        except Exception as exc:
            self.reply(rid, error=failure_message(exc, method, str(self.model.get("key") or "")))

    def _inference(self, messages):
        # Cancellation must not wait for an unresponsive provider. A cancelled
        # result has no path back into the transcript or tool dispatcher.
        result = queue.Queue(maxsize=1)
        cancel, finished = self.cancel, threading.Event()
        emission = threading.Lock()
        schemas = self.tools.schemas()
        def on_text(text):
            with emission:
                if not cancel.is_set() and not finished.is_set():
                    self.update({"sessionUpdate": "agent_message_chunk",
                                 "content": {"type": "text", "text": text}})
        def on_usage(tokens):
            with emission:
                if not cancel.is_set() and not finished.is_set():
                    self.update({"sessionUpdate": "harness2_usage", "tokens": tokens})
        def infer():
            try:
                result.put((True, request(self.model, messages, schemas,
                                         on_text=on_text, on_usage=on_usage)))
            except Exception as exc:
                result.put((False, exc))
        threading.Thread(target=infer, daemon=True).start()
        try:
            while not cancel.is_set():
                try:
                    ok, value = result.get(timeout=.05)
                    if ok:
                        return value
                    raise value
                except queue.Empty:
                    pass
            raise Cancelled
        finally:
            with emission:
                finished.set()

    def turn(self, rid, prompt):
        try:
            content = []
            for block in prompt:
                if block.get("type") == "text":
                    content.append({"type": "text", "text": block["text"]})
                elif block.get("type") == "image":
                    content.append({"type": "image_url", "image_url": {
                        "url": "data:" + block["mimeType"] + ";base64," + block["data"]}})
                else:
                    raise ValueError("Unsupported prompt block")
            if not content:
                raise ValueError("Empty prompt")
            self.session.recover_interrupted()
            self.session.messages.append({"role": "user", "content": content})
            self.session.save()
            calls_used = 0
            for _round in range(MAX_ROUNDS):
                if self.cancel.is_set():
                    raise Cancelled
                system = EXECUTOR_PROMPT + "\nWorkspace: " + self.session.cwd
                system += "\nConfigured MCP servers: " + ", ".join(self.tools.servers)
                message, tokens = self._inference([
                    {"role": "system", "content": system}, *self.session.messages])
                if self.cancel.is_set():
                    raise Cancelled
                self.session.messages.append(message)
                self.session.save()
                calls = message.get("tool_calls") or []
                if not calls:
                    self.reply(rid, {"stopReason": "end_turn"})
                    return
                for call in calls:
                    calls_used += 1
                    if calls_used > MAX_CALLS:
                        raise ValueError("Harness² tool call limit reached")
                    if self.cancel.is_set():
                        raise Cancelled
                    name = call["function"]["name"]
                    arguments = json.loads(call["function"]["arguments"])
                    kind = {"read_file": "read", "list_directory": "read",
                            "write_file": "edit", "run_command": "execute"}.get(name, "other")
                    self.update({"sessionUpdate": "tool_call", "toolCallId": call["id"],
                                 "title": name, "kind": kind, "rawInput": arguments})
                    failed = False
                    try:
                        result = self.tools.call(call)
                        text = json.dumps(result, ensure_ascii=False)
                        if len(text) > 65536:
                            text = text[:65536] + "\n[Tool output truncated; narrow the next query.]"
                    except Cancelled:
                        raise
                    except Exception:
                        # Tool/provider diagnostics can include credentials. The
                        # exact approval remains visible in the trusted host UI.
                        failed, text = True, "Tool failed or permission was denied. Inspect the inputs and current capabilities before retrying."
                    self.session.messages.append({"role": "tool", "tool_call_id": call["id"], "content": text})
                    self.session.save()
                    self.update({"sessionUpdate": "tool_call_update", "toolCallId": call["id"],
                        "status": "failed" if failed else "completed",
                        "content": [{"type": "content", "content": {"type": "text", "text": text}}]})
            raise ValueError("Harness² iteration limit reached")
        except Cancelled:
            self.reply(rid, {"stopReason": "cancelled"})
        except Exception as exc:
            self.reply(rid, error=failure_message(exc, "session/prompt", str(self.model.get("key") or "")),
                       diagnosis=exc if isinstance(exc, StructuredFailure) else None)


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")
    model = json.loads(os.environ.pop(MODEL_ENV, "{}"))
    root = os.environ.pop(ROOT_ENV, "")
    raw_config = os.environ.pop("SODUWORK_MCP_SERVERS_JSON", "")
    config_path = os.environ.pop("SODUWORK_MCP_SERVERS", "")
    if not raw_config and config_path:
        with open(config_path, "rb") as handle:
            raw = handle.read(2_000_001)
        if len(raw) > 2_000_000:
            return 2
        raw_config = raw.decode("utf-8-sig")
    config = json.loads(raw_config or "{}")
    if not root:
        return 2
    peer = Peer(model, root, config.get("servers") or {})
    try:
        while True:
            line = sys.stdin.readline(MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE:
                return 2
            value = json.loads(line)
            if not isinstance(value, dict):
                return 2
            peer.receive(value)
    finally:
        peer.cancel.set()
        if peer.worker:
            peer.worker.join(timeout=2)
        if peer.session:
            peer.session.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
