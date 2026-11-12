"""Access-policy implementation in the trusted ACP subprocess bridge."""
from __future__ import annotations

import http.client
import hashlib
import json
import os
import uuid
from urllib.parse import urlsplit

try:
    from .access_scope import automatic_path, automatic_query, trusted_program, query_execution_args
    from .skill_read_scope import ReadScope
except ImportError:
    from access_scope import automatic_path, automatic_query, trusted_program, query_execution_args
    from skill_read_scope import ReadScope


class AccessError(RuntimeError):
    pass


class BridgeAccess:
    def __init__(self, raw: str | None = None, *, agent_name: str = ""):
        self.agent_name = agent_name
        self.native_reads = {}
        self.native_calls = {}
        self.native_call_bytes = 0
        # Remove the secret before the Agent or any terminal is launched.
        value = raw if raw is not None else os.environ.pop("SODUWORK_APPROVAL_CHANNEL", "")
        self.channel = json.loads(value) if value else None
        self.policy = dict((self.channel or {}).get("policy") or {})
        self.mode = str(self.policy.get("mode") or "")
        self.read_scope = ReadScope((self.channel or {}).get("readScope") or ())
        self.opencode_guard = None
        if self.channel:
            url = urlsplit(str(self.channel.get("url") or ""))
            if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port:
                raise AccessError("Invalid local permission channel")
            self.port = url.port
            if self.mode not in {"standard", "full", "readonly"}:
                raise AccessError("Invalid access mode")

    def agent_environment(self, agent_name: str, env: dict) -> dict:
        if self.enabled and agent_name in {"codex-harness", "codex"}:
            # Bootstrap conservatively across adapter versions. The authenticated
            # policy handshake selects the advertised mode before any prompt.
            env = {**env, "INITIAL_AGENT_MODE": "read-only"}
        if self.enabled and agent_name == "opencode":
            try:
                from .opencode_access import Guard
            except ImportError:
                from opencode_access import Guard
            self.opencode_guard = Guard(opencode_permissions(self.mode, selected_resources=bool(self.read_scope.payload())), self.mode)
            return self.opencode_guard.environment(env)
        return env

    def close(self):
        if self.opencode_guard:
            self.opencode_guard.close()
            self.opencode_guard = None

    @property
    def enabled(self):
        return self.channel is not None

    def call(self, path: str, payload: dict) -> dict:
        if not self.channel:
            raise AccessError("No permission channel")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=910)
        try:
            connection.request("POST", path, json.dumps(payload).encode(), {
                "Authorization": "Bearer " + str(self.channel.get("token") or ""),
                "Content-Type": "application/json"})
            response = connection.getresponse()
            if response.status != 200:
                raise AccessError("Permission channel rejected this request")
            value = json.loads(response.read(65536))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError, http.client.HTTPException) as exc:
            raise AccessError("Permission channel is unavailable; operation was not approved") from exc
        finally:
            connection.close()

    def approve(self, action: str, target: str, arguments: dict,
                *, title: str = "", kind: str = "", operation_id: str = "",
                locations=None, tool: str = "", allow_session=True) -> bool:
        encoded = json.dumps(arguments, sort_keys=True, ensure_ascii=False).encode("utf-8")
        # A large edit still needs an exact grant, but does not need to copy a
        # complete document or binary payload into the confirmation UI.
        if len(encoded) > 16000:
            summary = {"inputDigest": hashlib.sha256(encoded).hexdigest(),
                       "inputBytes": len(encoded)}
            if arguments.get("inputIncomplete"):
                summary["inputIncomplete"] = True
            if self.agent_name in {"codex-harness", "codex"} and kind == "edit" and isinstance(arguments.get("changes"), list):
                changes = arguments["changes"]
                summary["changeCount"] = len(changes)
                summary["changes"] = [{
                    "path": str(row.get("path") or "")[:1000],
                    "kind": (row.get("_meta") or {}).get("kind", "edit") if isinstance(row.get("_meta"), dict) else "edit",
                    "oldBytes": len(str(row.get("oldText") or "").encode("utf-8")),
                    "newBytes": len(str(row.get("newText") or "").encode("utf-8")),
                } for row in changes[:12] if isinstance(row, dict)]
            arguments = summary
        response = self.call("/request", {
            "operationId": operation_id or uuid.uuid4().hex,
            "action": action, "target": target, "arguments": arguments,
            "title": title or action, "kind": kind, "locations": locations or [],
            "tool": tool, "allowSession": bool(allow_session),
            "reason": "This operation needs permission beyond the current automatic allowance."})
        return response.get("decision") == "once"

    def automatic_path(self, workspace: str, value: str, *, write=False) -> bool:
        # A selected package is a read grant even when it is inside the workspace.
        # Its stricter credential exclusions and immutable identity take precedence.
        if self.read_scope.contains(workspace, value):
            return not write and self.read_scope.allows(workspace, value)
        return automatic_path(workspace, value, write=write)

    def observe_tool(self, update: dict):
        if self.agent_name in {"codex-harness", "codex", "opencode", "dsh", "kimi", "claude"}:
            self._observe_native(update)
        if self.agent_name in {"codex-harness", "codex"}:
            return
        # OpenCode's permission event intentionally carries metadata, not the
        # original arguments. Bind omitted read inputs to this exact live call.
        if self.agent_name != "opencode" or update.get("sessionUpdate") not in ("tool_call", "tool_call_update"):
            return
        call_id = str(update.get("toolCallId") or "")
        if not call_id:
            return
        if update.get("status") in ("completed", "failed"):
            self.native_reads.pop(call_id, None)
            return
        if "rawInput" not in update:
            if update.get("sessionUpdate") == "tool_call" or update.get("kind") not in (None, "read"):
                self.native_reads.pop(call_id, None)
            return
        raw = update.get("rawInput")
        if update.get("kind") == "read" and isinstance(raw, dict) and set(raw) <= {"filePath", "filepath", "path", "offset", "limit"}:
            paths = [raw[key] for key in ("filePath", "filepath", "path") if raw.get(key)]
            if paths:
                self.native_reads[call_id] = paths
                return
        self.native_reads.pop(call_id, None)

    def _observe_native(self, update: dict):
        # ACP adapters can send inputs before the permission request. Keep
        # bounded live inputs by exact call identity, never replayed outputs.
        event = update.get("sessionUpdate")
        call_id = str(update.get("toolCallId") or "")
        if event not in {"tool_call", "tool_call_update"} or not call_id:
            return
        previous, size = self.native_calls.pop(call_id, ({}, 0))
        self.native_call_bytes -= size
        if update.get("status") in {"completed", "failed"}:
            return
        if (event == "tool_call" or update.get("kind") is not None
                and previous.get("kind") != update["kind"]):
            previous = {}
        value = {**previous, **{key: update[key] for key in
                 ("kind", "title", "rawInput", "locations", "content") if key in update}}
        encoded = json.dumps(value, ensure_ascii=False).encode("utf-8")
        # Oversized or evicted inputs remain unknown and must still be reviewed.
        if len(encoded) > 2 * 1024 * 1024:
            return
        while self.native_calls and (len(self.native_calls) >= 64
                                     or self.native_call_bytes + len(encoded) > 4 * 1024 * 1024):
            _, removed = self.native_calls.pop(next(iter(self.native_calls)))
            self.native_call_bytes -= removed
        self.native_calls[call_id] = (json.loads(encoded), len(encoded))
        self.native_call_bytes += len(encoded)

    def _restore_native_inputs(self, call: dict):
        cached = self.native_calls.get(str(call.get("toolCallId") or ""), ({}, 0))[0]
        # DSH and Kimi omit the kind. OpenCode sends the permission kind, whose
        # external_directory pre-gate must not inherit a read/edit operation.
        if self.agent_name in {"dsh", "kimi", "claude"} and not call.get("kind") and cached:
            call["kind"] = cached.get("kind")
        if not cached or cached.get("kind") != call.get("kind"):
            return
        for key in ("title", "content"):
            if not call.get(key) and key in cached:
                call[key] = cached[key]
        locations = list(call.get("locations") or [])
        for location in cached.get("locations") or []:
            if location not in locations:
                locations.append(location)
        if locations:
            call["locations"] = locations
        original, metadata = cached.get("rawInput"), call.get("rawInput")
        if metadata is None or metadata == {}:
            if original is not None:
                call["rawInput"] = original
        elif self.agent_name == "opencode" and isinstance(original, dict) and isinstance(metadata, dict):
            # OpenCode forwards gate metadata, which omits workdir/timeout and
            # actual write contents. Preserve every execution argument. If a
            # gate contradicts a live input, retain both and forbid reuse.
            conflict = {key: original[key] for key in original.keys() & metadata.keys()
                        if original[key] != metadata[key]}
            call["rawInput"] = {**original, **metadata}
            if conflict:
                call["rawInput"]["inputIncomplete"] = True
                call["rawInput"]["liveInputConflict"] = conflict

    def _codex_operation(self, params: dict, call: dict):
        call_id = str(call.get("toolCallId") or "")
        cached = self.native_calls.get(call_id, ({}, 0))[0]
        # A permission update can omit fields, but a changed tool kind cannot
        # inherit another operation's inputs. Never parse display titles.
        if cached.get("kind") == call.get("kind"):
            for key in ("title", "rawInput", "locations", "content"):
                if call.get(key) is None and key in cached:
                    call[key] = cached[key]
        meta = params.get("_meta")
        codex = meta.get("codex") if isinstance(meta, dict) else None
        source = codex.get("params") if isinstance(codex, dict) else None
        source = source if isinstance(source, dict) and call_id and source.get("itemId") == call_id else {}
        raw = call.get("rawInput")
        if call.get("kind") == "execute" and source:
            # The official adapter strips the shell from rawInput.command.
            # Preserve the original command, shell flags and all extra fields.
            command = source.get("command")
            if not command and isinstance(raw, dict):
                command = raw.get("command")
            if isinstance(command, str) and command.strip():
                arguments = {**(raw if isinstance(raw, dict) else {}), **source, "command": command}
                if not arguments.get("cwd") and isinstance(raw, dict) and raw.get("cwd"):
                    arguments["cwd"] = raw["cwd"]
                return "native.command", "codex.shell", arguments, True
        if raw is not None:
            return "native.tool", "", raw if isinstance(raw, dict) else {"input": raw}, True
        content = call.get("content")
        arguments = {"inputIncomplete": True}
        if isinstance(content, list) and content:
            changes = []
            for item in content:
                if not isinstance(item, dict) or item.get("type") != "diff":
                    changes = []
                    break
                change = {key: item[key] for key in ("path", "oldText", "newText", "_meta") if key in item}
                changes.append(change)
            arguments["changes" if changes else "content"] = changes or content
            if changes:
                call["locations"] = [*list(call.get("locations") or []),
                                     *[{"path": row["path"]} for row in changes if isinstance(row.get("path"), str)]]
        else:
            arguments["inputUnavailable"] = True
        if source:
            arguments["approvalContext"] = source
        # codex-acp 1.6.2 omits failed-to-render changes and the source of moves.
        # These diffs explain the request; they cannot prove its full write set
        # or safely support a reusable grant. grantRoot is a scope, not a file.
        return "native.tool", "", arguments, False

    def native_permission(self, params: dict) -> bool:
        call = dict(params.get("toolCall") or {})
        if self.agent_name in {"opencode", "dsh", "kimi", "claude"}:
            self._restore_native_inputs(call)
        arguments = call.get("rawInput")
        arguments = (arguments if isinstance(arguments, dict) else
                     {"inputUnavailable": True} if arguments is None else {"input": arguments})
        if arguments.get("inputUnavailable") and call.get("content"):
            # Some CLIs request approval before publishing canonical inputs.
            # Show their explanation for one-time review, but never treat display
            # text as executable arguments or as evidence for a reusable grant.
            arguments["display"] = call["content"]
        action, tool, allow_session = "native.tool", "", call.get("rawInput") is not None
        if self.agent_name in {"codex-harness", "codex"}:
            action, tool, arguments, allow_session = self._codex_operation(params, call)
        elif self.agent_name in {"opencode", "dsh", "kimi", "claude"} and (not arguments or arguments.get("inputIncomplete")):
            arguments = arguments or {"inputUnavailable": True}
            allow_session = False
        if (call.get("kind") == "execute" and isinstance(arguments.get("command"), str)
                and arguments["command"].strip() and not arguments.get("inputIncomplete")):
            meta = call.get("_meta") or {}
            if self.agent_name == "opencode":
                # OpenCode's native ACP mapper assigns execute only to bash/shell;
                # MCP tools use other. Never infer tool identity from a title.
                action, tool = "native.command", "opencode.shell"
                cached = self.native_calls.get(str(call.get("toolCallId") or ""), ({}, 0))[0]
                original = cached.get("rawInput")
                if not (cached.get("kind") == "execute" and isinstance(original, dict)
                        and isinstance(original.get("command"), str) and original["command"].strip()):
                    # Permission metadata alone cannot prove the shell's cwd,
                    # timeout or other omitted native execution parameters.
                    allow_session = False
            elif self.agent_name == "qwen" and isinstance(meta, dict) and meta.get("toolName") == "run_shell_command":
                action, tool = "native.command", "qwen.shell"
        locations = call.get("locations") or []
        target = str(arguments.get("command") or arguments.get("path") or
                     arguments.get("file_path") or arguments.get("filePath") or arguments.get("filepath") or
                     arguments.get("url") or "")
        if not target and locations and isinstance(locations[0], dict):
            target = str(locations[0].get("path") or "")
        kind = str(call.get("kind") or "other")
        # Auto-admission uses concrete inputs, never a model-supplied title.
        root = str(self.policy.get("workspaceRoot") or "")
        call_id = str(call.get("toolCallId") or "")
        if self.agent_name == "opencode" and call_id:
            # external_directory is only the first native gate; edit/bash still
            # pass their independent permission gate. Never grant its glob.
            if kind == "other" and set(arguments) == {"filepath", "parentDir"}:
                self.native_reads.pop(call_id, None)
                file, parent = arguments.get("filepath"), arguments.get("parentDir")
                if (isinstance(file, str) and isinstance(parent, str)
                        and self.read_scope.allows(root, file)
                        and os.path.normcase(os.path.abspath(parent)) == os.path.normcase(os.path.dirname(os.path.abspath(file)))
                        and all(isinstance(item, dict) and item.get("path") in (file, parent) for item in locations)):
                    self.native_reads[call_id] = [file]
                    return True
            if kind == "read" and (not arguments or arguments == {"inputUnavailable": True}) and not locations:
                files = self.native_reads.get(call_id) or []
                if files and all(self.automatic_path(root, value) for value in files):
                    return True
        paths = [arguments[key] for key in ("path", "file_path", "filePath", "filepath")
                 if arguments.get(key)]
        paths += [item.get("path") for item in locations if isinstance(item, dict) and item.get("path")]
        file_keys = {"path", "file_path", "filePath", "filepath", "content", "old_string", "new_string",
                     "oldText", "newText", "oldString", "newString", "replace_all", "replaceAll",
                     "line", "limit", "offset"}
        if (self.agent_name == "opencode" and kind == "edit"
                and isinstance(arguments.get("filepath"), str) and isinstance(arguments.get("diff"), str)):
            # Native edit/write permission metadata names its single actual
            # target and complete patch. Batch patches/moves remain reviewed.
            file_keys.add("diff")
        meta = call.get("_meta") or {}
        if self.agent_name == "qwen" and isinstance(meta, dict):
            if kind == "read" and meta.get("toolName") == "read_file":
                file_keys.add("pages")
            if kind == "edit" and meta.get("toolName") == "write_file":
                file_keys.add("record_as_artifact")
        permitted_kind = kind == "read" or (kind == "edit" and self.mode == "standard")
        if (permitted_kind and paths and set(arguments) <= file_keys
                and all(self.automatic_path(root, value, write=kind == "edit") for value in paths)):
            return True
        return self.approve(action, target, arguments,
                            title=str(call.get("title") or call.get("kind") or "Agent operation"),
                            kind=str(call.get("kind") or "other"),
                            operation_id=str(call.get("toolCallId") or ""), locations=locations,
                            tool=tool, allow_session=allow_session)

    def terminal_program(self, command, args, cwd, env):
        root = str(self.policy.get("workspaceRoot") or "")
        if (self.mode == "standard" and automatic_query(root, command, args=args, cwd=cwd, env=env, read_scope=self.read_scope)):
            return trusted_program(command, root)
        return ""

    def terminal_arguments(self, command, args):
        return query_execution_args([command, *args])

    def path(self, workspace: str, value: str, *, write=False, arguments=None) -> str:
        if not value or not os.path.isabs(value):
            raise AccessError("File paths must be absolute")
        if write and self.mode == "readonly":
            raise AccessError("Read-only sessions cannot write files")
        target = os.path.realpath(value)
        allowed = self.automatic_path(workspace, value, write=write)
        if not allowed and not self.approve("file.write" if write else "file.read", target,
                                           {"path": target, **dict(arguments or {})},
                                           title="Access outside the automatic workspace allowance"):
            raise AccessError("File access was not approved")
        if os.path.normcase(os.path.realpath(value)) != os.path.normcase(target):
            raise AccessError("The file target changed while awaiting permission")
        return target

    def apply(self, bridge, session: dict):
        if not self.enabled:
            return
        # OpenCode uses a concrete deny/ask/allow map injected by the trusted
        # host. Its ACP 'modes' select agents, not permission levels.
        native_mode = "permission-map"
        if bridge.agent_name == "opencode":
            available = {str(item.get("value"))
                         for option in session.get("configOptions", [])
                         if option.get("id") == "mode"
                         for item in option.get("options", [])}
            marker = self.opencode_guard and self.opencode_guard.agent_id
            if not marker or marker not in available or self.opencode_guard.profile not in available:
                raise AccessError("ACCESS_POLICY_UNSUPPORTED: OpenCode did not apply the final access configuration")
            bridge.request("session/set_config_option", {
                "sessionId": bridge.session_id, "configId": "mode", "value": self.opencode_guard.profile})
        else:
            modes = dict(session.get("modes") or {})
            available = {str(item.get("id")) for item in modes.get("availableModes", [])
                         if isinstance(item, dict)}
            mapping = {
                "harness2": {"standard": ("standard",), "readonly": ("readonly",), "full": ("full",)},
                # New adapters reserve 'agent' for a remote auto-review service.
                # Prefer the advertised user-approval mode; older adapters expose
                # only 'agent', whose historical contract is workspace access.
                "codex-harness": {"standard": ("workspace-write", "agent"), "readonly": ("read-only",),
                                  "full": ("agent-full-access",)},
                "codex": {"standard": ("workspace-write", "agent"), "readonly": ("read-only",),
                          "full": ("agent-full-access",)},
                "qwen": {"standard": ("default",), "readonly": ("plan",), "full": ("yolo",)},
                "kimi": {"standard": ("default",), "readonly": ("plan",), "full": ("yolo",)},
                "claude": {"standard": ("default",), "readonly": ("plan",),
                           "full": ("bypassPermissions",)},
                "dsh": {"standard": ("workspace-write",), "readonly": ("read-only",),
                        "full": ("danger-full-access",)},
            }
            candidates = mapping.get(bridge.agent_name, {}).get(self.mode, ())
            native_mode = next((value for value in candidates if value in available), "")
            if not native_mode:
                raise AccessError("ACCESS_POLICY_UNSUPPORTED: Agent did not advertise the requested permission mode")
            # Always apply, including restored native sessions. A saved wider
            # native mode must not override the current SoduWork policy.
            bridge.request("session/set_mode", {"sessionId": bridge.session_id,
                                                "modeId": native_mode})
        result = self.call("/applied", {"mode": self.mode, "nativeMode": native_mode})
        if not result.get("ok"):
            raise AccessError("Access policy could not be applied to this execution")


def opencode_permissions(mode: str, *, selected_resources=False) -> dict:
    if mode == "readonly":
        return {"*": "deny", "read": "ask", "list": "allow", "glob": "allow",
                "grep": "ask", "external_directory": "ask" if selected_resources else "deny"}
    if mode == "full":
        return {"*": "allow", "question": "deny", "doom_loop": "deny"}
    # File requests return immediately in the bridge for ordinary workspace
    # paths. Routing them through it preserves case-insensitive credential and
    # symlink checks instead of overriding OpenCode's protected-file defaults.
    return {"*": "ask", "read": "ask", "list": "allow", "glob": "allow", "grep": "ask",
            "edit": "ask", "bash": "ask", "webfetch": "ask", "external_directory": "ask",
            "question": "deny", "doom_loop": "deny"}
