"""Native tool schemas and host calls; model output never supplies host policy."""
from __future__ import annotations

import json
import time


def _tool(name, description, properties, required):
    return {"name": name, "description": description, "parameters": {
        "type": "object", "properties": properties, "required": required,
        "additionalProperties": False}}


STRING = {"type": "string"}
TOOLS = [
    _tool("read_file", "Read a UTF-8 file using an absolute path; bounded to 2000 lines.",
          {"path": STRING, "line": {"type": "integer", "minimum": 1},
           "limit": {"type": "integer", "minimum": 1, "maximum": 2000}}, ["path"]),
    _tool("list_directory", "List up to 500 immediate names in an absolute directory.",
          {"path": STRING}, ["path"]),
    _tool("write_file", "Write exact UTF-8 content to an existing directory. Read before replacing.",
          {"path": STRING, "content": STRING}, ["path", "content"]),
    _tool("run_command", "Execute a program with separate arguments, without an implicit shell. Use an explicit shell for shell syntax. Execution is bounded and needs current permission.",
          {"command": STRING, "args": {"type": "array", "items": STRING, "maxItems": 256},
           "cwd": STRING, "timeout": {"type": "integer", "minimum": 1, "maximum": 120}}, ["command"]),
    _tool("webfetch", "Read an HTTP(S) URL after permission. Redirects are rejected; response size and time are bounded.",
          {"url": STRING, "format": {"type": "string", "enum": ["text"]},
           "timeout": {"type": "integer", "minimum": 1, "maximum": 30}}, ["url"]),
    _tool("list_mcp_tools", "Discover tools of one configured MCP server. No arbitrary server URLs or commands.",
          {"server": STRING}, ["server"]),
    _tool("call_mcp_tool", "Call a discovered, allowed tool of a configured MCP server.",
          {"server": STRING, "tool": STRING, "arguments": {"type": "object"}},
          ["server", "tool", "arguments"]),
]


class Tools:
    def __init__(self, peer, servers):
        self.peer = peer
        self.servers = servers
        self.discovered = {}

    def schemas(self):
        names = {"read_file", "list_directory"}
        if self.peer.mode != "readonly":
            if self.peer.capabilities.get("_meta", {}).get("harness2", {}).get("webfetch") is True:
                names.add("webfetch")
            if self.peer.capabilities.get("fs", {}).get("writeTextFile"):
                names.add("write_file")
            if self.peer.capabilities.get("terminal"):
                names.add("run_command")
            if self.servers:
                names.update({"list_mcp_tools", "call_mcp_tool"})
        return [tool for tool in TOOLS if tool["name"] in names]

    def call(self, call):
        name = call["function"]["name"]
        arguments = json.loads(call["function"]["arguments"])
        schema = next((tool["parameters"] for tool in self.schemas() if tool["name"] == name), None)
        if not schema or not isinstance(arguments, dict):
            raise ValueError("Tool is unavailable under the current capabilities")
        if set(arguments) - set(schema["properties"]) or set(schema["required"]) - set(arguments):
            raise ValueError("Invalid tool argument fields")
        for key, value in arguments.items():
            rule = schema["properties"][key]
            kind = rule["type"]
            if rule.get("enum") and value not in rule["enum"]:
                raise ValueError("Invalid tool argument value")
            if (kind == "string" and not isinstance(value, str)
                    or kind == "integer" and (type(value) is not int
                        or value < rule.get("minimum", 0) or value > rule.get("maximum", 2**31))
                    or kind == "object" and not isinstance(value, dict)
                    or kind == "array" and (not isinstance(value, list)
                        or len(value) > rule.get("maxItems", 256)
                        or not all(isinstance(item, str) for item in value))):
                raise ValueError("Invalid tool argument type or range")
        if name in {"read_file", "write_file", "list_directory"}:
            method = {"read_file": "fs/read_text_file", "write_file": "fs/write_text_file",
                      "list_directory": "fs/list_directory"}[name]
            return self.peer.host(method, arguments)
        if name == "run_command":
            params = {k: v for k, v in arguments.items() if k != "timeout"}
            params["outputByteLimit"] = 65536
            terminal = self.peer.host("terminal/create", params)
            try:
                deadline = time.monotonic() + arguments.get("timeout", 60)
                while True:
                    result = self.peer.host("terminal/output", terminal)
                    if result.get("exitStatus") is not None:
                        self.peer.host("terminal/wait_for_exit", terminal)
                        return self.peer.host("terminal/output", terminal)
                    if time.monotonic() >= deadline:
                        self.peer.host("terminal/kill", terminal)
                        raise ValueError("Terminal timed out and was stopped")
                    self.peer.cancel.wait(.05)
            finally:
                self.peer.host("terminal/release", terminal, allow_cancel=True)
        if name == "webfetch":
            return self._web(arguments, call["id"])
        return self._mcp(name, arguments, call["id"])

    def _permission(self, name, arguments, call_id, kind="other"):
        permission = self.peer.host("session/request_permission", {
            "sessionId": self.peer.session.id,
            "toolCall": {"toolCallId": call_id, "kind": kind, "title": name,
                         "rawInput": arguments},
            "options": [{"optionId": "allow", "kind": "allow_once", "name": "Allow"},
                        {"optionId": "deny", "kind": "reject_once", "name": "Deny"}]})
        if permission.get("outcome", {}).get("optionId") != "allow":
            raise ValueError("Operation was not approved")

    def _web(self, arguments, call_id):
        import urllib.parse
        import urllib.request
        from .mcp_http import _NoRedirect, _response_chunks
        parsed = urllib.parse.urlsplit(arguments["url"])
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password):
            raise ValueError("Invalid web URL")
        self._permission("webfetch", arguments, call_id, "fetch")
        timeout = arguments.get("timeout", 20)
        deadline = time.monotonic() + timeout
        with urllib.request.build_opener(_NoRedirect()).open(arguments["url"], timeout=timeout) as response:
            return {"content": b"".join(_response_chunks(response, deadline)).decode("utf-8", errors="replace")}

    def _mcp(self, name, arguments, call_id):
        server = arguments["server"]
        spec = self.servers.get(server)
        if not isinstance(spec, dict) or spec.get("enabled") is False:
            raise ValueError("MCP server is not configured for this dispatch")
        self._permission(name, arguments, call_id)
        from .harness2_mcp import list_tools, call_tool
        if name == "list_mcp_tools":
            rows = list_tools(server, spec, self.peer.cancel)
            self.discovered[server] = {row["name"] for row in rows}
            return {"tools": rows}
        if arguments["tool"] not in self.discovered.get(server, set()):
            raise ValueError("Discover the allowed MCP tools before calling one")
        return call_tool(server, spec, arguments["tool"], arguments["arguments"], self.peer.cancel)
