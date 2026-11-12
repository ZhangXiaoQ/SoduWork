"""Public module behavior and service contracts."""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

from . import codex_runtime_home as _codex_runtime_home
from .runtime_defaults import DEFAULT_OUTPUT

log = logging.getLogger("uvicorn.error")

_ANSI = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")

# Use silence as the primary timeout criterion, with a generous absolute limit against permanently stuck runs.
_IDLE_LIMIT_S = int(os.environ.get("SODUWORK_LOCAL_IDLE_LIMIT_S") or 15 * 60)
_HARD_LIMIT_S = int(os.environ.get("SODUWORK_LOCAL_HARD_LIMIT_S") or 8 * 3600)
_TIMEOUT_S = _HARD_LIMIT_S          # Compatibility alias for older callers.

# Use a configurable context-window estimate when the gateway cannot report the real limit.
# Label estimates in the UI and replace them with observed limits when overflow errors provide one.
_CTX_WINDOW_DEFAULT = int(os.environ.get("SODUWORK_LOCAL_CTX_WINDOW") or 128000)
_COMPACT_AT = 0.85                  # Compact before the next turn when context occupancy reaches this threshold.

_RUNS: dict[str, dict] = {}     # Execution ref to in-memory state; the archive directory holds the authoritative persisted copy.
_LOCK = threading.RLock()
_RECLAIM_LOCK = threading.Lock()
# Retain strong references to background execution workers.
_THREADS: set = set()

def _data_root() -> str:
    """Cross-platform archive root: LOCALAPPDATA on Windows, Application Support on macOS, and
    XDG_DATA_HOME or .local/share on Linux. Avoid Windows home paths where security software may
    block atomic rename.
    """
    explicit = str(os.environ.get("SODUWORK_DATA_ROOT") or "").strip()
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    home = os.path.expanduser("~")
    if os.name == "nt":
        return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(home, ".soduwork"),
                            "soduwork")
    if sys.platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "soduwork")
    return os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share"),
                        "soduwork")


# Keep session archives outside workspaces and source repositories.
# Execution logs must not dirty the user's Git working tree.
_STORE = os.path.join(_data_root(), "local-runs")
_MEM_LINES = 4000               # Bound in-memory events; events.jsonl retains the complete history.


# CLI invocation profiles.
_WIN = os.name == "nt"


def _npm_root() -> str:
    """Locate global npm packages using standard Windows and POSIX installation directories."""
    if _WIN:
        prefix = str(os.environ.get("npm_config_prefix") or os.environ.get("NPM_CONFIG_PREFIX") or "").strip()
        if prefix:
            return os.path.join(os.path.abspath(prefix), "node_modules")
        from .agent_npm_runtime import configured_global_root
        configured = configured_global_root()
        if configured:
            return configured
        return os.path.join(os.environ.get("APPDATA", ""), "npm", "node_modules")
    home = os.path.expanduser("~")
    # npm may be installed under a private Runner prefix (for example
    # /opt/soduwork-node-current).  Looking only in /usr/local made the Runner
    # discover the wrong global tree: the package was installed successfully,
    # but Codex's platform dependency could not be found afterwards.  Prefer
    # the configured/inferred npm prefix before the system fallbacks.
    candidates = []
    for name in ("NPM_CONFIG_PREFIX", "npm_config_prefix"):
        prefix = str(os.environ.get(name) or "").strip()
        if prefix:
            candidates.append(os.path.join(prefix, "lib", "node_modules"))
    try:
        npm = shutil.which("npm") or shutil.which("npm.cmd")
        if npm:
            raw_path = os.path.abspath(npm)
            candidates.append(os.path.join(
                os.path.dirname(os.path.dirname(raw_path)), "lib", "node_modules"))
            # npm's launcher is often a symlink into <prefix>/lib/node_modules.
            # Resolve that layout without treating the npm package directory
            # itself as the prefix.
            real_path = os.path.realpath(raw_path)
            marker = os.sep + "lib" + os.sep + "node_modules" + os.sep
            if marker in real_path:
                prefix = real_path.split(marker, 1)[0]
                candidates.append(os.path.join(prefix, "lib", "node_modules"))
    except OSError:
        pass
    candidates.extend(("/usr/local/lib/node_modules", "/usr/lib/node_modules",
                       os.path.join(home, ".npm-global", "lib", "node_modules"),
                       os.path.join(home, ".nvm", "versions")))
    seen = set()
    for p in candidates:
        if p in seen:
            continue
        seen.add(p)
        if os.path.isdir(p):
            return p
    return ""


def _real_bin(cands: list[str], names: list[str]) -> str | None:
    """Find the real executable in known locations before searching PATH. Avoid Windows .cmd and
    .ps1 shims that can reparse multiline prompts; POSIX npm symlinks are safe to resolve
    normally.
    """
    for p in cands:
        if p and os.path.isfile(p):
            return p
    for n in names:
        w = shutil.which(n)
        if not w:
            continue
        if _WIN and w.lower().endswith((".ps1", ".cmd", ".bat")):
            continue             # Treat a Windows shim without a real executable as unavailable.
        return w
    return None


def _claude_bin() -> str | None:
    # Native install, account probing and ACP execution resolve the same file.
    from .agent_native_install import active_binary
    return active_binary(_data_root()) or None


def _opencode_bin() -> str | None:
    # OpenCode is lifecycle-managed by ``managed_agents``.  Do not fall back to
    # an arbitrary executable from PATH when there is no active managed install:
    # user-level binaries can be stale or CPU-incompatible and a version probe
    # would block the Runner heartbeat (or crash with SIGILL).  The install/check
    # flow is the single source of truth for this harness.
    try:
        from .managed_agents import opencode_binary
        managed = opencode_binary()
        if managed:
            return managed
    except Exception:  # noqa: BLE001 - legacy PATH lookup remains available
        pass
    root = _npm_root()
    exe = "opencode.exe" if _WIN else "opencode"
    rels = ["bin/" + exe]
    if _WIN:
        rels += ["node_modules/opencode-windows-x64/bin/opencode.exe",
                 "node_modules/opencode-windows-x64-baseline/bin/opencode.exe"]
    elif sys.platform == "darwin":
        rels += ["node_modules/opencode-darwin-arm64/bin/opencode",
                 "node_modules/opencode-darwin-x64/bin/opencode"]
    else:
        rels += ["node_modules/opencode-linux-x64/bin/opencode",
                 "node_modules/opencode-linux-arm64/bin/opencode"]
    cands = [os.path.join(root, "opencode-ai", *r.split("/")) for r in rels] if root else []
    # Keep an already-installed PATH binary usable as a compatibility path.
    # The managed binary remains preferred, while discovery still works for
    # machines that installed OpenCode before SoduWork took over lifecycle setup.
    return _real_bin(cands, [exe, "opencode"])


def _opencode_runtime_issue() -> str:
    from .managed_agents import runtime_issue
    return runtime_issue()


def _bundled_pi_cli_js() -> str | None:
    """Pi shipped with the desktop client; never require a user-level npm install."""
    p = str(os.environ.get("SODUWORK_BUNDLED_PI_CLI") or "").strip()
    return os.path.abspath(p) if p and os.path.isfile(p) else None


def _bundled_pi_node() -> str | None:
    """The packaged SoduWork executable can act as Node via ELECTRON_RUN_AS_NODE."""
    p = str(os.environ.get("SODUWORK_BUNDLED_NODE") or "").strip()
    return os.path.abspath(p) if p and os.path.isfile(p) else None

def _pi_cli_js() -> str | None:
    """Locate Pi's dist/cli.js in @earendil-works/pi-coding-agent and run it directly with Node. Pi
    has no native executable; similarly named npm packages are unrelated.
    """
    bundled = _bundled_pi_cli_js()
    if bundled:
        return bundled
    root = _npm_root()
    from . import agent_npm_runtime
    entry = agent_npm_runtime.package_entry("@earendil-works/pi-coding-agent", "pi", root)
    if entry:
        return entry
    if not root:
        return None
    p = os.path.join(root, "@earendil-works", "pi-coding-agent", "dist", "cli.js")
    return p if os.path.isfile(p) else None


def _pi_bin() -> str | None:
    """Return Node only when both Node and Pi's cli.js are available; the profile supplies cli.js
    as the first argument.
    """
    if not _pi_cli_js():
        return None
    return _bundled_pi_node() or shutil.which("node") or shutil.which("node.exe")


def _codex_bin() -> str | None:
    """Prefer owned packages and only execute a native Windows platform binary."""
    from .agent_npm_runtime import package_roots, private_bin, runtime_target
    private = private_bin(["codex"]) if not _WIN else ""
    if private:
        return private
    exe = "codex.exe" if _WIN else "codex"
    cands: list[str] = []
    system, arch = runtime_target()
    suffix = {"win32": "-pc-windows-msvc", "linux": "-unknown-linux-musl", "darwin": "-apple-darwin"}.get(system)
    if arch and suffix:
        triple = ("x86_64" if arch == "x64" else "aarch64") + suffix
        for root in package_roots(_npm_root()):
            package = os.path.join(root, "@openai", "codex")
            try:
                with open(os.path.join(package, "package.json"), encoding="utf-8") as stream:
                    manifest = json.load(stream)
            except (OSError, ValueError, TypeError):
                continue
            # A hoisted native package can belong only to Codex Harness. The
            # personal package must exist before its dependency is discoverable.
            if not isinstance(manifest, dict) or manifest.get("name") != "@openai/codex":
                continue
            native = os.path.join("@openai", f"codex-{system}-{arch}")
            cands.extend(os.path.join(base, "vendor", triple, "bin", exe) for base in (
                os.path.join(package, "node_modules", native), os.path.join(root, native), package))
    found = _real_bin(cands, [exe, "codex"])
    # Codex desktop may add an internal WindowsApps resource directory to PATH.
    # Ordinary backend processes may lack permission to execute that bundled binary.
    # Exclude it while retaining the independently installed npm platform executable.
    if _WIN and found and "\\windowsapps\\openai.codex_" in found.lower():
        return None
    return found


def _codex_args(sid: str, mode: str, ws: str | None, cfg: dict | None = None,
                resume: bool = False) -> list:
    """Behavior and constraints for this operation."""
    args = ["--json", "--skip-git-repo-check"]
    if not resume:
        # Planning uses read-only mode; working execution uses danger-full-access.
        # The supported workspace-write mode can deny writes to .git.
        # That blocks branch operations, commits, hooks, and pushes required for delivery.
        # Do not work around those restrictions by copying Git metadata elsewhere.
        # The configured working mode permits unattended Git operations.
        # Apply the same trusted-workspace boundary as the other CLI executors.
        args += ["-s", "read-only" if mode == "plan" else "danger-full-access"]
    # Both start and resume accept -c; enforce approval policy on every turn.
    args += ["-c", "approval_policy=never",
             "-c", "sandbox_workspace_write.network_access=true"]
    model = str((cfg or {}).get("codex_model") or "").strip()
    effort = str((cfg or {}).get("codex_reasoning_effort") or "").strip().lower()
    if model or effort:
        from . import agent_execution_options
    if model:
        state = agent_execution_options.validate_native_model("local:codex", model)
        if not state["ok"]:
            raise ValueError(str(state["detail"]))
        args += ["-m", model]
    if effort:
        effort = agent_execution_options.normalize_reasoning_effort(
            effort, allow_empty=False)
        args += ["-c", 'model_reasoning_effort="%s"' % effort]
    if ws and not resume:
        args = ["-C", ws, *args]
    for img in (cfg or {}).get("images") or []:
        p = str(img or "").strip()
        if p and os.path.isfile(p):
            args.append("--image=" + p)
    servers = (cfg or {}).get("mcpConfig")
    if isinstance(servers, dict):
        for name, spec in servers.items():
            if not isinstance(spec, dict) or not spec.get("command"):
                continue
            # SoduWork's MCP bridge enforces plugin tool allowlists.
            # Directly configuring raw servers would bypass allowedTools, so controlled calls use the shared bridge.
            if ("allowedTools" in spec or spec.get("enabledTools")
                    or spec.get("disabledTools")):
                continue
            # Restrict TOML dotted-path keys to supported ASCII characters.
            safe = "".join(c for c in str(name)
                           if c.isascii() and (c.isalnum() or c in "-_"))[:48]
            if not safe:
                continue
            args += ["-c", "mcp_servers.%s.command=%s" % (
                safe, json.dumps(str(spec["command"]), ensure_ascii=False))]
            argv_list = [str(x) for x in (spec.get("args") or [])]
            args += ["-c", "mcp_servers.%s.args=%s" % (
                safe, json.dumps(argv_list, ensure_ascii=False))]
            args += ["-c", "mcp_servers.%s.startup_timeout_sec=%d" % (
                safe, min(120, max(3, int(spec.get("startupTimeoutSeconds") or 10))))]
            args += ["-c", "mcp_servers.%s.tool_timeout_sec=%d" % (
                safe, min(300, max(3, int(spec.get("toolTimeoutSeconds") or 60))))]
    return args


def _pi_model(cfg: dict) -> str:
    return ((cfg or {}).get("llm") or {}).get("model") or ""


def _pi_args(sid: str, mode: str, cfg: dict | None) -> list:
    """Build Pi arguments with cli.js first because the executable is Node. Pi uses the subprocess
    working directory directly and needs no --dir flag.
    """
    args = [_pi_cli_js() or "", "-p", "--mode", "json", "--session-id", sid,
            "--provider", "company", "--model", _pi_model(cfg),





            "--exclude-tools", "ask_question",
            # Trust the configured project files so unattended execution can load its .pi skills and settings.
            # Otherwise a trust prompt may prevent required capabilities from loading.
            "--approve"]
    # Pi supports repeatable --skill arguments for Agent Skills.
    # The orchestration layer resolves paths; the adapter only builds the command line.
    # The runtime loads matching skill instructions during execution.
    for p in ((cfg or {}).get("skillPaths") or []):
        args += ["--skill", str(p)]
    if mode == "plan":
        # Planning disables write-capable tools and retains read and search tools.
        args += ["--tools", "read,list,glob,grep"]
    return args


# Each CLI profile defines start, resume, planning, and context-compaction behavior.
# Register new runtimes here without changing upper-layer orchestration.
# start and resume accept sid, mode, ws, and cfg.
# Pi needs cfg to place the selected model in its command arguments.
_NATIVE_PROFILES = {
    "opencode": {
        "name": "OpenCode",
        "bin": _opencode_bin,
        "runtime_issue": _opencode_runtime_issue,
        "runtime_probe": _opencode_runtime_issue,
        # Pass OpenCode's --dir explicitly.
        # Relying only on subprocess cwd can write outputs into the backend repository instead.
        "start": lambda sid, mode, ws, cfg=None: ["run", "--format", "json", "--thinking", "--dir", ws],
        # Capture OpenCode's provider-issued session ID from output and use it for resume.
        "resume": lambda sid, mode, ws, cfg=None: ["run", "--format", "json", "--thinking", "--dir", ws,
                                                   "--session", sid],
        "needs_llm": True,          # Use the shared model service, injecting configuration through OPENCODE_CONFIG_CONTENT.
        "own_session": False,       # The CLI assigns its own session ID.
        # Session console: attach the TUI to the conversation currently associated with this task.
        "session_flag": ["--session"],
        "compact": lambda run: _compact_opencode(run),
    },
    "claude": {
        "name": "Claude Code",
        "bin": _claude_bin,
        "needs_llm": False,
        "own_session": True,        # SoduWork assigns this runtime's session ID before execution.
        "start": lambda sid, mode, ws, cfg=None: [
            "-p", "--session-id", sid, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            # Planning uses the CLI's native plan mode.
            # Working mode uses acceptEdits rather than bypassPermissions.
            "--permission-mode", "plan" if mode == "plan" else "acceptEdits",
        ],
        "resume": lambda sid, mode, ws, cfg=None: [
            "-p", "--resume", sid, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--permission-mode", "plan" if mode == "plan" else "acceptEdits",
        ],
        # Claude resumes the same session with --resume; omitting -p opens its interactive interface.
        "session_flag": ["--resume"],
        # Let Claude manage its own context compaction.
        "compact": None,
    },











    "pi": {
        "name": "Pi",
        "bin": _pi_bin,
        "needs_llm": True,          # Use the shared model service with ~/.pi/agent/models.json (see _write_pi_models).
        "own_session": True,
        "start": lambda sid, mode, ws, cfg=None: _pi_args(sid, mode, cfg),
        # Resume by explicit session ID rather than the most recent session.
        # This prevents concurrent tasks from continuing each other's conversations.
        "resume": lambda sid, mode, ws, cfg=None: _pi_args(sid, mode, cfg),
        # pi --session <id> without -p opens the interactive interface for the same session.
        # argv_prefix places cli.js before other arguments because the executable is Node.
        "session_flag": ["--session"],
        "argv_prefix": lambda: [_pi_cli_js() or ""],
        # Let Pi manage its native compaction and overflow retries.
        "compact": None,
    },














    "codex": {
        "name": "Codex",
        "bin": _codex_bin,
        "needs_llm": False,
        "own_session": False,
        "start": lambda sid, mode, ws, cfg=None: _account_acp.start_args(sid, mode, ws, cfg),
        "resume": lambda sid, mode, ws, cfg=None: _account_acp.resume_args(sid, mode, ws, cfg),
        "command": lambda exe, args, ws, cfg: _account_acp.command_argv(exe, args, ws, cfg),
        # codex resume <id> opens the interactive interface for the existing session.
        "session_flag": ["resume"],
        # Let Codex manage its native compaction.
        "compact": None,
    },
}
# ACP is the stable expansion boundary. New ACP agents reuse the exact same
# run archive, task status, artifact scan and follow-up machinery as native CLIs.
from ..agent_catalog import AGENTS as _AGENT_CATALOG
from . import acp_agents as _acp_agents
from . import codex_account_acp as _account_acp
from . import harness2_runtime as _harness2_runtime

_NATIVE_PROFILES["harness2"] = _harness2_runtime.profile()

_PROFILES = {
    key: (_acp_agents.profile(key) if row["runner"]["adapter"] == "acp" else {
        **_NATIVE_PROFILES[key], "name": row["displayName"],
        "needs_llm": row["modelMode"] == "managed",
    }) for key, row in _AGENT_CATALOG.items()
}


def _command_argv(exe: str, args: list[str], ws: str, cfg: dict,
                  prof: dict) -> list[str]:
    """Build process argv, allowing protocol adapters to wrap a native CLI."""
    if cfg.get("accessPolicy") and prof is _PROFILES.get("opencode"):
        session = ""
        if "--session" in args:
            session = args[args.index("--session") + 1]
        metadata = _acp_agents.run_args(session, cfg.get("_soduwork_agent_mode") or "work", ws, cfg)
        return _acp_agents.command_argv("opencode", exe, metadata, ws, cfg)
    if prof is _PROFILES.get("opencode") and cfg.get("_inputImages"):
        args = [*args, *["--file=" + item["path"] for item in cfg["_inputImages"]]]
    builder = (prof or {}).get("command")
    return list(builder(exe, list(args), ws, cfg) if callable(builder)
                else [exe, *args])



def _compact_opencode(run: dict) -> bool:
    """Compact context with a deferred local_ctx import to avoid circular imports with local_base.

    """
    from .local_ctx import _oc_compact
    return _oc_compact(run)


def _cfg_profile(cfg: dict) -> str:
    return (cfg or {}).get("local_cli") or "opencode"


def _workspace_root(cfg: dict) -> str:
    """Behavior and constraints for this operation."""
    root = ((cfg or {}).get("local_workspace_root") or "").strip()
    return root or os.path.join(_data_root(), "workspaces")


# Persistent session archives.
def _store_dir(ref: str) -> str:
    d = os.path.join(_STORE, ref)
    os.makedirs(d, exist_ok=True)
    return d


_PERSIST_KEYS = ("cli", "ws", "taskId", "state", "started", "ended", "exit", "error",
                 "failureKind", "failurePath", "cliSid", "model", "pid", "seq", "segment", "round",
                 "tokens", "ctxWindow", "ctxWindowKnown", "usage", "firstStarted",
                 "detached", "mode", "title", "gitDelivery", "codeTask", "artifactMode",
                 "workspaceGuard", "workspaceManaged", "executionPolicy", "turnCompleted",
                 "completionRetries", "expectedOutputPaths", "expectedOutputBaseline",
                 "executionPolicyState", "executionPolicyViolation")

_PERSIST_KEYS += ("stream", "terminal", "contextSegments", "compacted", "contextRequest", "overflowTried")
_PERSIST_KEYS += ("executionStartedAt",)
_PERSIST_KEYS += ("accessPolicy", "nextAccessPolicy", "appliedAccessPolicy", "skillSelection")
_PERSIST_KEYS += ("conversationMode", "turnStartSeq", "admissionKey", "reasoningEffort", "codexTransport")
_PERSIST_KEYS += ("turnEndIdentity", "admissionStartSeq")


def _save_meta(ref: str) -> None:
    """Persist runtime metadata with atomic replacement to avoid partial JSON after a crash."""
    with _LOCK:
        run = _RUNS.get(ref)
        if not run:
            return
        _record_terminal(ref, run)
        if run.get("cli") == "codex":
            run["codexTransport"] = (run.get("cfg") or {}).get(_account_acp.TRANSPORT_KEY, run.get("codexTransport") or "")
        data = {k: run.get(k) for k in _PERSIST_KEYS}
        # Keep snapshot and replacement in one ordered critical section.
        data["ref"] = ref
        try:
            d = _store_dir(ref)
            blob = json.dumps(data, ensure_ascii=False)
            dst = os.path.join(d, "meta.json")
            tmp = dst + ".tmp"
            try:
                with open(tmp, "w", encoding="utf-8") as f:
                    f.write(blob)
                os.replace(tmp, dst)              # Prefer atomic replacement.
            except OSError:
                # Fall back to a direct write when the filesystem blocks renaming.
                # Readers tolerate malformed metadata because a direct write may be interrupted.
                with open(dst, "w", encoding="utf-8") as f:
                    f.write(blob)
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        except Exception as e:  # noqa: BLE001 - Archive failures must not terminate execution.
            log.warning("本地 run 存档失败 %s: %s", ref[:8], type(e).__name__)


def _save_baseline(ref: str, seen: set) -> None:
    try:
        with open(os.path.join(_store_dir(ref), "base.json"), "w", encoding="utf-8") as f:
            json.dump([[a, b] for a, b in seen], f)
    except Exception:  # noqa: BLE001
        pass


def _load_baseline(ref: str) -> set:
    try:
        with open(os.path.join(_store_dir(ref), "base.json"), encoding="utf-8") as f:
            return {(a, b) for a, b in json.load(f)}
    except Exception:  # noqa: BLE001
        return set()


def _append_events(ref: str, items: list[dict]) -> None:
    if not items:
        return
    try:
        with open(os.path.join(_store_dir(ref), "events.jsonl"), "a", encoding="utf-8") as f:
            for it in items:
                f.write(json.dumps(it, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001
        pass

def _record_event(ref: str, item: dict) -> dict | None:
    """Append one product-level event with the run's authoritative sequence."""
    if not isinstance(item, dict):
        return None
    with _LOCK:
        run = _RUNS.get(ref)
        if not run:
            return None
        stamped = dict(item)
        stamped["seq"] = int(run.get("seq") or 0) + 1
        stamped["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        stamped["seg"] = int(run.get("segment") or 1)
        from . import turn_correlation
        turn_correlation.stamp(run, stamped)
        run["seq"] = stamped["seq"]
        run["lines"] = (run.get("lines") or []) + [stamped]
        del run["lines"][:-_MEM_LINES]
    _append_events(ref, [stamped])
    _save_meta(ref)
    return stamped


def _record_terminal(ref: str, run: dict) -> None:
    """Caller holds the run lock; commit the boundary before another turn can start."""
    from . import turn_correlation
    event = turn_correlation.terminal(run)
    if event is None:
        return
    event.update(seq=int(run.get("seq") or 0) + 1, seg=int(run.get("segment") or 1),
                 at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    run["seq"] = event["seq"]
    run["lines"] = (run.get("lines") or []) + [event]
    del run["lines"][:-_MEM_LINES]
    _append_events(ref, [event])



def _read_events(ref: str, since: int = 0, limit: int = 400) -> list[dict]:
    """Read archived activity when it is unavailable in memory after restart or buffer eviction."""
    out: list[dict] = []
    try:
        with open(os.path.join(_store_dir(ref), "events.jsonl"), encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    it = json.loads(ln)
                except Exception:  # noqa: BLE001
                    continue
                if int(it.get("seq") or 0) > since:
                    out.append(it)
    except FileNotFoundError:
        return []
    except Exception:  # noqa: BLE001
        return out[:limit]
    return out[:limit]


# Cap raw diagnostic output to prevent excessive disk growth.
# Pi delta events can repeat the entire partial message.
# Retaining every prefix can produce quadratic log growth.
# Keep the bounded initial diagnostic record and indicate truncation.
# Structured events provide the separate audit history.
_RAW_CAP = 8 * 1024 * 1024
_RAW_SIZE: dict[str, int] = {}          # Track bytes written per execution to avoid stat calls for every line.


def _append_raw(ref: str, text: str) -> None:
    """Return raw terminal diagnostics for the console. Stop writing at _RAW_CAP and add an
    explicit truncation notice.
    """
    try:
        n = _RAW_SIZE.get(ref)
        if n is None:
            try:
                n = os.path.getsize(os.path.join(_store_dir(ref), "raw.log"))
            except OSError:
                n = 0
        if n >= _RAW_CAP:
            return
        blob = text
        hit = n + len(blob.encode("utf-8", "ignore")) >= _RAW_CAP
        if hit:
            blob += (f"\n===== 原始输出已到上限（{_RAW_CAP // 1048576}MB），后面的不再落盘 =====\n"
                     "（结构化实况仍然完整；这一段只是排障用的原文）\n")
        with open(os.path.join(_store_dir(ref), "raw.log"), "a", encoding="utf-8") as f:
            f.write(blob)
        _RAW_SIZE[ref] = _RAW_CAP if hit else n + len(blob.encode("utf-8", "ignore"))
    except Exception:  # noqa: BLE001
        pass


def raw_tail_sync(cfg: dict, ref: str, limit: int = 60000) -> dict:
    p = os.path.join(_STORE, ref, "raw.log")
    try:
        size = os.path.getsize(p)
        with open(p, encoding="utf-8", errors="replace") as f:
            if size > limit:
                f.seek(size - limit)
                f.readline()          # Discard an incomplete trailing line.
            return {"ok": True, "text": f.read(), "truncated": size > limit, "size": size}
    except FileNotFoundError:
        return {"ok": False, "text": "", "error": "这条会话没有原始输出存档"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "text": "", "error": type(e).__name__}


def _pid_alive(pid: int | None) -> bool:
    """Check process liveness across platforms for session reclamation."""
    if not pid:
        return False
    try:
        if _WIN:
            r = subprocess.run(["tasklist", "/FI", f"PID eq {int(pid)}", "/NH"],
                               capture_output=True, timeout=15,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            # Localized tasklist emits the Windows code page even when Runner
            # enables UTF-8. PID digits are ASCII; decoding the whole response
            # could throw and incorrectly claim an existing process is gone.
            return str(pid).encode("ascii") in (r.stdout or b"")
        if sys.platform.startswith('linux'):
            from .linux_process_tree import alive, read_process
            return alive(read_process(int(pid)))
        os.kill(int(pid), 0)          # Probe without sending a signal; permission denial still indicates an existing process.
        return True
    except PermissionError:
        return True
    except Exception:  # noqa: BLE001
        return False


def _restore_stream_checkpoint(run: dict) -> None:
    """Merge durable event checkpoints into the possibly stale meta cursor."""
    stream = dict(run.get("stream") or {})
    offsets = dict(stream.get("offsets") or {})
    terminal = dict(run.get("terminal") or {})
    for item in run.get("lines") or []:
        source = str(item.get("_stream") or "")
        if source in ("out", "err"):
            try:
                end = int(item.get("_streamEnd") or 0)
            except (TypeError, ValueError):
                end = 0
            offsets[source] = max(int(offsets.get(source) or 0), end)
        if isinstance(item.get("_terminal"), dict):
            terminal = dict(item["_terminal"])
    if stream:
        stream["offsets"] = offsets
        run["stream"] = stream
    run["terminal"] = terminal


def reclaim() -> dict:
    """Reclaim archived sessions at Runner startup. Resume durable spool parsing from its cursor
    and recover the exit code; monitor live legacy processes without spools as detached. Mark
    missing processes interrupted rather than silently losing them.
    """
    # `job.has` also uses this function to recover one historical ref after a Hub
    # restart.  It may therefore run while this Runner is actively executing other
    # refs.  Never replace an in-memory run with its throttled disk snapshot: doing
    # so detaches the original process watcher and incorrectly turns an ordinary
    # live run into a restart-recovery run whose exit code can no longer be polled.
    # Serialising scans also prevents two simultaneous `job.has` calls from attaching
    # duplicate recovery readers to the same spool.
    with _RECLAIM_LOCK:
        return _reclaim_missing()


def _reclaim_missing() -> dict:
    n_live = n_dead = 0
    try:
        refs = [d for d in os.listdir(_STORE)
                if os.path.isfile(os.path.join(_STORE, d, "meta.json"))]
    except FileNotFoundError:
        return {"live": 0, "ended": 0}
    for ref in refs:
        with _LOCK:
            if ref in _RUNS:
                continue
        try:
            with open(os.path.join(_STORE, ref, "meta.json"), encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:  # noqa: BLE001
            continue
        run = {k: meta.get(k) for k in _PERSIST_KEYS}
        # Older archives seeded this exact placeholder before the first request.
        if run.get("tokens") == {"input": 0, "output": 0, "total": 0}:
            run["tokens"] = {}
        run["proc"] = None
        run["queue"] = []
        run["cfg"] = {}
        if run.get("cli") == "codex" and run.get("codexTransport") == _account_acp.TRANSPORT:
            run["cfg"][_account_acp.TRANSPORT_KEY] = _account_acp.TRANSPORT
        pending_policy = run.get("nextAccessPolicy")
        if pending_policy and pending_policy.get("mode") == "full":
            from . import access_policy
            run["nextAccessPolicy"] = access_policy.normalize({**pending_policy,
                "mode": "standard", "revision": pending_policy["revision"] + 1}, run["ws"])
        if run.get("accessPolicy"):
            run["permissionWaiting"] = False
            run["pendingPermissions"] = []
            run["accessReauthorizationRequired"] = True
            run["appliedAccessPolicy"] = {}
        run["seen"] = _load_baseline(ref)
        run["lines"] = _read_events(ref, 0, 10 ** 9)[-_MEM_LINES:]
        _restore_stream_checkpoint(run)
        # Resume sequence numbering from the maximum archived event, not throttled metadata.
        # Reusing an old sequence number would hide events from incremental clients.
        run["seq"] = max(int(run.get("seq") or 0),
                         max((int(x.get("seq") or 0) for x in run["lines"]), default=0))
        run["segment"] = int(run.get("segment") or 1)
        run["round"] = int(run.get("round") or 1)
        with _LOCK:
            # A dispatch may have registered this ref while its snapshot was being
            # read.  The live object is always newer and must win that race.
            if ref in _RUNS:
                continue
            _RUNS[ref] = run
        if run.get("state") == "running" and run.get("accessPolicy"):
            # The approval token and session grants deliberately die with the
            # Runner. Stop this new-contract process before offering resume;
            # never reconnect it with stale full-access or an orphaned approval.
            from .local_stream import _kill_pid_tree
            if not _kill_pid_tree(int(run.get("pid") or 0)):
                # A failed stop acknowledgement must not become proof of exit.
                # Keep the original execution active until its watcher confirms exit.
                run.update(state="running", detached=True,
                           error="Previous process cleanup is not confirmed; stop it before resuming",
                           failureKind="access_reauthorization_cleanup")
                n_live += 1
                _save_meta(ref)
                _watch_detached(ref)
                continue
            run.update(state="interrupted", detached=False, ended=time.time(),
                       error="Access session interrupted by Runner restart; confirm permissions to resume",
                       failureKind="access_reauthorization")
            n_dead += 1
            _save_meta(ref)
            continue
        if run.get("state") == "running":
            from . import local_spool
            if local_spool.recoverable(_store_dir(ref), run.get("stream") or {}):
                run["detached"] = False
                n_live += 1
                _save_meta(ref)
                from .local_stream import _recover_stream
                _recover_stream(ref)
                continue
            if _pid_alive(run.get("pid")):
                run["detached"] = True
                n_live += 1
                _watch_detached(ref)
            else:
                run["state"] = "interrupted"
                run["error"] = "后端重启时这一轮已经不在了（多半是跟着一起退了）"
                run["ended"] = time.time()
                n_dead += 1
            _save_meta(ref)
    if n_live or n_dead:
        log.info("本地会话认领：%d 个继续恢复/盯梢 · %d 个已结算", n_live, n_dead)
    return {"live": n_live, "ended": n_dead}


def rehydrate(ref: str):
    """On a memory miss, reclaim an existing archive before resuming or delivering feedback. Return
    None when absent; _RECLAIM_LOCK serializes concurrent recovery.
    """
    if not os.path.isfile(os.path.join(_STORE, ref, "meta.json")):
        return None
    reclaim()
    with _LOCK:
        return _RUNS.get(ref)


def _watch_detached(ref: str) -> None:
    """Monitor a still-running process whose stdout cannot be reattached, then settle it when it
    exits so artifacts can return.
    """
    def _w():
        while True:
            time.sleep(5)
            with _LOCK:
                run = _RUNS.get(ref)
                pid = (run or {}).get("pid")
                if not run or run.get("state") != "running":
                    return
                observed = run
                reclaim_cleanup = bool(run.get("accessReauthorizationRequired") and
                    run.get("failureKind") == "access_reauthorization_cleanup")
            if reclaim_cleanup:
                # Unknown process identity or an inconclusive probe cannot authorize resume.
                if not pid:
                    continue
                from .local_stream import _pid_alive as process_alive
                alive = process_alive(pid)
            else:
                alive = _pid_alive(pid)
            if not alive:
                with _LOCK:
                    run = _RUNS.get(ref)
                    if run is not observed or run.get("pid") != pid:
                        return
                    if run and run.get("state") == "running":
                        run["state"] = ("interrupted" if reclaim_cleanup else
                                        "stopped" if run.get("stopping") else "done")
                        run["ended"] = time.time()
                        # Describe interruption without assuming the backend restarted.
                        # Runner replacement or local process cleanup can cause the same condition.
                        # Diagnostics should identify the actual executor boundary without an unsupported cause.
                        run["error"] = ("Access session interrupted by Runner restart; confirm permissions to resume"
                                        if reclaim_cleanup else "你把它叫停了" if run.get("stopping") else
                                        "这一轮的实时输出没接回来（执行机中途断过或被重启）；"
                                        "产出以工作目录为准")
                        if reclaim_cleanup:
                            run["failureKind"] = "access_reauthorization"
                            run["detached"] = False
                        run["stopping"] = False
                _save_meta(ref)
                return
    th = threading.Thread(target=_w, name="ai_local:watch:" + ref[:8], daemon=True)
    _THREADS.add(th)
    th.start()


def _prepare_codex_home(env: dict) -> None:
    """Backward-compatible test hook for the Codex skill-directory guard."""
    _codex_runtime_home.clean_skills(env)


def _env_for(prof: dict, cfg: dict, runtime_ref: str = "") -> dict:
    """Build the child-process environment; inject OpenCode model configuration and credentials through environment variables instead of files."""
    env = dict(os.environ)
    from . import runtime_images
    env.pop(runtime_images.ENV_KEY, None)
    if cfg.get(runtime_images.CFG_KEY):
        if not runtime_ref:
            raise runtime_images.ImageInputError("图片附件缺少会话归属，请重新发送")
        if (prof.get("acp_key") or prof is _PROFILES.get("opencode") or prof is _PROFILES.get("harness2")) and not runtime_images.transport_supported(cfg.get("llm")):
            raise runtime_images.ImageInputError("当前所选模型未启用图片输入，请手动选择支持图片的模型后重试；原图已保留，未自动更换模型")
        env[runtime_images.ENV_KEY] = runtime_images.environment(cfg, os.path.join(_store_dir(runtime_ref), "inputs"))
    # Agent skills may launch Python subprocesses. Keep their text boundary
    # Unicode-safe instead of inheriting Windows' locale-dependent codepage.
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    for k in ("NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"):
        env.pop(k, None)
    if prof is _PROFILES.get("pi") and _bundled_pi_node():
        env["ELECTRON_RUN_AS_NODE"] = "1"
    work_root = str((cfg or {}).get("local_workspace_root") or "").strip()
    if work_root and prof.get("acp_key") != "dsh":
        absolute = os.path.abspath(os.path.expanduser(work_root)).rstrip("\\/")
        task_temp = os.path.join(absolute, "temp")
        try:
            os.makedirs(task_temp, exist_ok=True)
        except OSError as exc:
            raise RuntimeError(
                "任务临时目录无法创建：" + task_temp) from exc
        # Keep CLI temporary files inside the user-authorized Runner work root.
        # Using a system temporary directory could exceed that workspace boundary.
        env["TEMP"] = env["TMP"] = env["TMPDIR"] = task_temp
    if prof.get("acp_key") == "dsh":
        # DSH's restricted-token sandbox requires a separate runtime temp root.
        # Keep its existing sandbox/approval policy; isolate only host internals.
        from .dsh_runtime import prepare_temp, apply_access_env
        prepare_temp(env, _data_root(), runtime_ref, work_root)
        apply_access_env(env, cfg.get("accessPolicy"))
    if prof is _PROFILES.get("codex"):
        # Give each session an independent CODEX_HOME to avoid desktop and concurrent-task cache conflicts.
        # Copy authentication state only, excluding personal hooks, MCP configuration, caches, and history.
        codex_home = _codex_runtime_home.prepare(env, _data_root(), runtime_ref)
    # Pass the out-of-repository MCP configuration path to the bridge.
    if (cfg or {}).get("mcpServers"):
        env["SODUWORK_MCP_SERVERS"] = str(cfg["mcpServers"])
    if isinstance((cfg or {}).get("mcpConfig"), dict):
        # Inject this dispatch's configuration into the subprocess without persisting credentials on the device.
        env["SODUWORK_MCP_SERVERS_JSON"] = json.dumps(cfg["mcpConfig"], ensure_ascii=False)
    # Resolve plugin secrets only on the execution machine; plaintext enters only that subprocess environment.
    for target, source in dict((cfg or {}).get("runtimeSecrets") or {}).items():
        if source in os.environ:
            env[str(target)] = os.environ[str(source)]
    if prof is _PROFILES.get("opencode"):
        from .opencode_runtime_config import prepare_environment
        prepare_environment(env, _data_root())
    # Use the task owner's Git identity and credentials.
    # Inject them before the needs_llm early return.
    # Self-authenticated runtimes still need Git credentials for code delivery.
    # Otherwise credentials would silently apply only to gateway-backed runtimes.
    if (cfg or {}).get("git"):
        from .code_creds import env_for as _git_env
        _git_env(env, cfg["git"])
    # Add repository hosts to NO_PROXY while preserving system proxies for other requests.
    # Set this before the needs_llm early return so agents using native accounts also inherit it.
    _git_host_no_proxy(env, str((cfg or {}).get("repoGitUrl") or ""))
    if prof is _PROFILES.get("harness2"):
        return _no_proxy_for(_harness2_runtime.environment(env, cfg, runtime_ref=runtime_ref),
                             str((cfg.get("llm") or {}).get("base") or ""))
    if not prof.get("needs_llm"):
        if prof.get("acp_key"):
            _acp_agents.home_env(prof["acp_key"], env, _data_root())
        if prof is _PROFILES.get("codex"):
            env["CODEX_HOME"] = codex_home
            _account_acp.prepare_env(env, cfg, _codex_bin() or "")
        return env
    llm = (cfg or {}).get("llm") or {}
    base, key, model = llm.get("base", ""), llm.get("key", ""), llm.get("model", "")
    kind = llm.get("kind") or "openai-compat"
    acp_key = str(prof.get("acp_key") or "")
    if not (base and key and model):
        if cfg.get("accessPolicy") and prof is _PROFILES.get("opencode"):
            raise RuntimeError("OpenCode requires a managed model before applying its access policy")
        # Reject ACP runtime startup when required model configuration is absent.
        # Do not silently start an agent without credentials.
        #   「Authentication required: Use Qwen Code CLI to authenticate first.」

        if acp_key:
            raise RuntimeError(
                "%s 没有拿到模型配置：这台设备当前没有可用模型。请在管理端「模型服务」"
                "为其配置或授权模型后重试；或在执行机上登录 %s 的个人账号。"
                % (prof.get("name") or acp_key, prof.get("name") or acp_key))
        return env
    env["SODUWORK_LLM_KEY"] = key
    if acp_key:
        _acp_agents.inject_llm_env(
            acp_key, env, llm,
            mode=str((cfg or {}).get("_soduwork_agent_mode") or "work"))
        # Keep agent state directories outside restricted home-directory locations.
        # Some security policies block the rename operations required for session archival.
        _acp_agents.home_env(acp_key, env, _data_root())
        if acp_key == "qwen":
            from . import qwen_runtime
            qwen_runtime.configure(env, llm, _data_root(), runtime_ref)
        return _no_proxy_for(env, base)

    if prof.get("name") == "Pi":
        # Pi reads model configuration from its agent models.json file.
        # Store only the SODUWORK_LLM_KEY environment reference, never the plaintext key.
        from .local_context_policy import window
        _write_pi_models(base, model, kind, window(cfg) or _CTX_WINDOW_DEFAULT, llm=llm)
        return _no_proxy_for(env, base)
    # OpenCode's default external_directory permission asks for confirmation, which unattended execution cannot provide.
    # Grant only the authorized Runner work root rather than enabling all permissions.
    # Deny the catch-all first, then allow the exact root because later matching rules take precedence.
    external = {"*": "deny"}
    if work_root:
        external[absolute + (r"\**" if os.name == "nt" else "/**")] = "allow"
        # Cover both native and forward-slash forms of the same Windows root.
        external[absolute.replace("\\", "/") + "/**"] = "allow"
    permission = {
        "edit": "allow", "bash": "allow",
        "webfetch": "allow" if (cfg or {}).get("networkAllowed") else "deny",
        "question": "deny", "doom_loop": "deny", "external_directory": external,
    }
    if (cfg or {}).get("accessPolicy"):
        from .acp_access import opencode_permissions
        permission = opencode_permissions(cfg["accessPolicy"]["mode"])
    provider_pkg = "@ai-sdk/anthropic" if kind == "anthropic" else "@ai-sdk/openai-compatible"
    from .local_context_policy import window
    context_limit = window(cfg) or _CTX_WINDOW_DEFAULT
    output_limit = runtime_images.model_fields(llm).get("maxOutputTokens", DEFAULT_OUTPUT)
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps({
        "$schema": "https://opencode.ai/config.json",
        "provider": {"company": {
            "npm": provider_pkg, "name": "SoduWork 模型服务",
            "options": {"baseURL": base, "apiKey": "{env:SODUWORK_LLM_KEY}"},
            "models": {model: {"name": "公司 coding 模型",
                "limit": {"context": context_limit, "output": min(output_limit, context_limit)},
                "modalities": {
                "input": ["text", "image"] if runtime_images.transport_supported(llm) else ["text"],
                "output": ["text"]}}}}},
        "model": f"company/{model}",
        # Working execution requires shell access to modify and verify code.
        # Restrict directory access to the authorized work root and disable unsupported interactive or looping behavior.
        "permission": permission,
    }, ensure_ascii=False)
    return _no_proxy_for(env, base)


def _no_proxy_for(env: dict, base: str) -> dict:
    """Configure direct model-service access and remove HTTP/HTTPS proxy variables."""
    host = ""
    try:
        from urllib.parse import urlparse
        host = urlparse(base).hostname or ""
    except Exception:  # noqa: BLE001
        pass
    if host:
        env["NO_PROXY"] = (host + "," + env.get("NO_PROXY", "")).strip(",")
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        env.pop(k, None)
    return env


def _git_host_no_proxy(env: dict, git_url: str) -> None:
    """Add repository hosts to NO_PROXY while preserving HTTP_PROXY for other services.
    
    This setting is independent of model-credential injection and also applies to CLIs using native accounts.
    """
    url = (git_url or "").strip()
    if not url:
        return
    try:
        from urllib.parse import urlparse
        host = urlparse(url).hostname or ""
    except Exception:  # noqa: BLE001
        host = ""
    if not host:
        return
    for k in ("NO_PROXY", "no_proxy"):   # Set both uppercase and lowercase proxy-bypass variables for Git and curl compatibility.
        parts = [p for p in (env.get(k, "") or "").split(",") if p.strip()]
        if host not in parts:
            parts.insert(0, host)
        env[k] = ",".join(parts)


def _write_pi_models(base: str, model: str, kind: str = "openai-compat", context_window: int = _CTX_WINDOW_DEFAULT, *, llm: dict | None = None) -> None:
    """Write ~/.pi/agent/models.json, which Pi requires instead of environment-only configuration.
    
    Keep plaintext keys off disk: apiKey contains only the $SODUWORK_LLM_KEY variable reference.
    _env_for injects its value into the child environment, using Pi's $ENV_VAR interpolation.
    OpenAI-compatible services may not support developer roles or reasoning_effort,
    so disable these optional capabilities through compat.
    Do not rewrite unchanged content; repeated writes are unnecessary and can race an active session.
    """
    from . import runtime_images
    try:
        d = os.path.join(os.path.expanduser("~"), ".pi", "agent")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, "models.json")
        provider = {
            "name": "SoduWork 模型服务",
            "baseUrl": base,
            "api": "anthropic-messages" if kind == "anthropic" else "openai-completions",
            "apiKey": "$SODUWORK_LLM_KEY",
            "models": [{"id": model, "name": "公司 coding 模型",
                        "input": ["text", "image"] if runtime_images.transport_supported(llm) else ["text"],
                        "contextWindow": context_window,
                        "maxTokens": min(runtime_images.model_fields(llm).get("maxOutputTokens", DEFAULT_OUTPUT), context_window)}],
        }
        if kind != "anthropic":
            provider["compat"] = {"supportsDeveloperRole": False, "supportsReasoningEffort": False}
        want = {"providers": {"company": provider}}
        blob = json.dumps(want, ensure_ascii=False, indent=1)
        try:
            if open(path, encoding="utf-8").read() == blob:
                return
        except Exception:  # noqa: BLE001 - Write configuration when the previous file is absent or unreadable.
            pass
        with open(path, "w", encoding="utf-8") as f:
            f.write(blob)
    except Exception as e:  # noqa: BLE001 - Let the runtime report configuration errors if this optional write fails.
        log.warning("写 pi models.json 失败：%s", type(e).__name__)


def _friendly(msg: str) -> str:
    """Convert recognized CLI failures into actionable messages, retaining unknown diagnostics
    rather than hiding them.
    """
    m = (msg or "").strip()
    if not m:
        return ""
    if "Not logged in" in m or "authentication_failed" in m or "/login" in m:
        return ("本机的 claude 没有可用凭据（CLI 报 Not logged in）。"
                "要么在这台机器上先把 CLI 登录好，要么给它配 API Key / 共享模型服务——"
                "这一步得由人来定，SoduWork 不替你存密钥。")
    if "Incorrect API key" in m or "invalid_api_key" in m:
        return ("模型服务的密钥不对（网关退回 401）。去管理端「集成源 → 模型服务」核一下 Key。"
                "原话：" + m[:200])
    if "usage limit" in m.lower() or "rate limit" in m.lower():
        return "本机 CLI 的额度用完或被限流了：" + m[:200]
    return m[:400]


def ctx_pct(run: dict) -> float:
    """Return context usage as a percentage, explicitly labeling estimates until the model window is confirmed."""
    win = int(run.get("ctxWindow") or _CTX_WINDOW_DEFAULT) or _CTX_WINDOW_DEFAULT
    used = int((run.get("tokens") or {}).get("input") or 0)
    return max(0.0, min(100.0, used * 100.0 / win))
