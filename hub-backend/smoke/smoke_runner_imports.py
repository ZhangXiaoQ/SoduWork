"""Verify standalone Runner dependency isolation from libraries excluded by runner.spec.

A top-level sqlalchemy import through execution_aliases once broke the dispatch-receipt
path in a packaged Runner. The detached session could continue while the Hub classified
dispatch as failed, leaving task and session state inconsistent.

Check both boundaries:
1. Statically audit the import graph from runner_main and reject top-level imports of
   runner.spec excluded libraries. Function-local lazy imports remain permitted.
2. Block those libraries in a child process, import every packaged Runner module, and call
   the affected naming function to verify operation without database dependencies.
"""
from __future__ import annotations

import ast
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVC = os.path.join(BASE, "app", "services")

# Keep the excluded dependency list aligned with runner.spec.
BANNED = ("sqlalchemy", "fastapi", "uvicorn", "pydantic", "pydantic_settings",
          "dotenv", "app.db", "app.models", "app.services.llm",
          "app.services.runner_access_policy", "app.services.model_runtime")

# Import the entry point and hidden-import modules in behavioral verification.
RUNNER_MODULES = [
    "app.services.acp_agents", "app.services.acp_bridge", "app.services.ai_local",
    "app.services.local_base", "app.services.agent_setup", "app.services.managed_agents",
    "app.services.local_stream", "app.services.local_ctx", "app.services.ai_prompts",
    "app.services.ai_flow_presets", "app.services.execution_capabilities",
    "app.services.execution_policy", "app.services.local_execution_policy",
    "app.services.execution_event_policy",
    "app.services.runtime_components", "app.services.skills", "app.services.workdirs",
    "app.services.workspace_guard", "app.services.code_creds",
    # Also test packaged modules reached through deferred imports.
    "app.services.execution_aliases", "app.services.agent_naming",
    "app.services.runner_scm", "app.services.runner_deploy", "app.services.runner_quality",
    "app.services.terminal_environment",
    # skills imports its inventory helpers; database policy must stay lazy and
    # absent in the standalone bundle, while Hub transport remains unchanged.
    "app.services.runner_hub",
    "app.services.conversation_turn_skills",
]

passed = failed = 0


def ok(cond: bool, name: str, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print("  PASS ", name)
    else:
        failed += 1
        print("  FAIL ", name, " << ", detail[:400])


def _imports(path: str) -> tuple[set[str], list[str]]:
    tree = ast.parse(open(path, encoding="utf-8").read())
    mods: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            mods.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = "app.services" if node.level == 1 else "app"
                if node.module:
                    mods.add(base + "." + node.module)
                else:
                    mods.update(base + "." + a.name for a in node.names)
            elif node.module:
                mods.add(node.module)
    top_banned: list[str] = []
    for node in tree.body:
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = "app.services" if node.level == 1 else "app"
                names = [base + "." + (node.module or a.name) for a in node.names] \
                    if not node.module else [base + "." + node.module]
            else:
                names = [node.module or ""]
        for name in names:
            if any(name == b or name.startswith(b + ".") for b in BANNED):
                top_banned.append(name)
    return mods, top_banned


def static_audit() -> None:
    spec = ast.parse(open(os.path.join(BASE, "runner.spec"), encoding="utf-8").read())
    analysis = next(node for node in ast.walk(spec) if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name) and node.func.id == "Analysis")
    excluded = next(item.value for item in analysis.keywords if item.arg == "excludes")
    excluded_names = {node.value for node in ast.walk(excluded)
                      if isinstance(node, ast.Constant) and isinstance(node.value, str)}
    ok(set(BANNED).issubset(excluded_names), "打包排除项与 Runner 依赖边界一致",
       str(sorted(set(BANNED) - excluded_names)))
    info: dict[str, tuple[set[str], list[str]]] = {}
    for f in os.listdir(SVC):
        if f.endswith(".py"):
            info["app.services." + f[:-3]] = _imports(os.path.join(SVC, f))
    seen: set[str] = set()
    parent: dict[str, str] = {}
    root_mods, root_banned = _imports(os.path.join(BASE, "runner_main.py"))
    ok(not root_banned, "runner_main 顶层不 import 被瘦身的库", str(root_banned))
    queue = [("runner_main", m) for m in root_mods if m.startswith("app.services.")]
    offenders: list[str] = []
    while queue:
        src, mod = queue.pop()
        # Modules excluded entirely from Runner need no internal dependency audit.
        # References to them must remain deferred and guarded.
        # Behavioral import tests verify that boundary.
        if any(mod == b or mod.startswith(b + ".") for b in BANNED):
            continue
        if mod in seen or mod not in info:
            continue
        seen.add(mod)
        parent[mod] = src
        mods, banned = info[mod]
        if banned:
            chain = [mod]
            while chain[-1] in parent:
                chain.append(parent[chain[-1]])
            offenders.append(f"{banned} @ {' <- '.join(chain)}")
        queue.extend((mod, n) for n in mods
                     if n.startswith("app.services.") and n not in seen)
    ok(len(seen) >= 20, "可达图覆盖了 Runner 主要模块（%d 个）" % len(seen), str(sorted(seen)))
    ok(not offenders, "Runner 可达模块顶层零 sqlalchemy/fastapi/pydantic",
       "; ".join(offenders))


_CHILD = r"""
import sys
from datetime import datetime, timedelta

BANNED_ROOTS = {"sqlalchemy", "fastapi", "uvicorn", "pydantic", "pydantic_settings", "dotenv"}

class _Block:
    def find_spec(self, name, path=None, target=None):
        root = name.split(".")[0]
        if root in BANNED_ROOTS or name in ("app.db", "app.models", "app.services.llm",
                                           "app.services.runner_access_policy", "app.services.model_runtime"):
            raise ModuleNotFoundError("No module named " + repr(name) + " (blocked: runner bundle)")
        return None

sys.meta_path.insert(0, _Block())
failures = []
for mod in __MODS__:
    try:
        __import__(mod)
    except Exception as exc:
        failures.append(mod + ": " + type(exc).__name__ + ": " + str(exc))
if failures:
    print("IMPORT-FAIL:", "; ".join(failures)); sys.exit(31)

# A packaged Runner must validate turn skills without Hub HTTP dependencies.
import asyncio
from app.services import conversation_turn_skills
assert asyncio.run(conversation_turn_skills.prepare(None, {})) == {"prompt": "", "selection": []}
try:
    asyncio.run(conversation_turn_skills.prepare(None, {"turnSkills": ["../private"]}))
except ValueError:
    pass
else:
    raise AssertionError("Runner accepted an invalid skill selection")

# Both naming paths must complete without database libraries in the Runner environment.
from app.services import execution_aliases, agent_naming, ai_local
label = execution_aliases.seat_name(
    {"machine": {}, "agent": {}},
    machine_key=agent_naming.machine_key(host="DESKTOP-FIXTURE"),
    cli_key="opencode", cli_name="OpenCode", machine_label="DESKTOP-FIXTURE")
assert label, "seat_name gave empty label"
seat = ai_local._seat_name("OpenCode", {}, "opencode")
assert seat, "ai_local._seat_name gave empty label"
from app.services import local_stream
stamp = local_stream._now_iso()
event_at = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
assert event_at.utcoffset() == timedelta(0), "Runner event timestamp is not explicit UTC: " + stamp
print("RUNNER-WORLD-OK", label, "|", seat)
"""


def behavior_probe() -> None:
    code = _CHILD.replace("__MODS__", repr(RUNNER_MODULES))
    proc = subprocess.run([sys.executable, "-X", "utf8", "-c", code], cwd=BASE,
                          capture_output=True, text=True, timeout=180)
    out = (proc.stdout or "") + (proc.stderr or "")
    ok(proc.returncode == 0 and "RUNNER-WORLD-OK" in out,
       "屏蔽 sqlalchemy 后全部 Runner 模块可导入、起名路径可走通", out[-600:])


if __name__ == "__main__":
    static_audit()
    behavior_probe()
    print(f"runner import smoke: {passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
