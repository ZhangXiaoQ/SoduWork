# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller recipe for the standalone SoduWork Runner."""
import os
import sys
import json
import hashlib
from importlib.metadata import version
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, copy_metadata
from packaging.requirements import Requirement

backend = os.path.abspath(SPECPATH)
project = os.path.dirname(backend)
sys.path.insert(0, backend)
from app.services.runner_sources import skill_files

release_profile = json.loads(Path(project, "tools/distribution/PUBLIC-SOURCE.json").read_text(encoding="utf-8"))
release_review = json.loads(Path(project, "third-party/public-release.json").read_text(encoding="utf-8"))
if (release_profile.get("sourceOnly") is not False or release_review.get("pending")) and os.environ.get("SODUWORK_INTERNAL_BUILD") != "1":
    raise RuntimeError("Public Runner distribution is blocked; SODUWORK_INTERNAL_BUILD=1 permits internal validation only")

skill_data = [(str(source), str(source.parent.relative_to(project)))
              for source in skill_files(Path(project))]

# Retain the installed distributions' original LICENSE/NOTICE files, including
# transitive requirements. Metadata collection does not import runtime modules.
license_data = [(os.path.join(project, "LICENSE"), "third-party")]
for line in Path(backend, "requirements-runner.txt").read_text(encoding="utf-8-sig").splitlines():
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    requirement = Requirement(line)
    if requirement.marker is None or requirement.marker.evaluate():
        license_data.extend(copy_metadata(requirement.name, recursive=True))
# Some wheels omit original permission text. Preserve only reviewed, exact-version
# upstream snapshots; a newer dependency must not silently inherit an old grant.
notice_manifest = json.loads(Path(project, "third-party", "manifest.json").read_text(encoding="utf-8"))
for override in notice_manifest.get("pythonNoticeOverrides", []):
    if version(override["name"]) != override["version"]:
        raise RuntimeError("Review original Python notice for installed version: " + override["name"])
    notice = next(item for item in notice_manifest["notices"] if item["id"] == override["notice"])
    original = Path(project, notice["path"]).resolve()
    if not original.is_relative_to(Path(project).resolve()):
        raise RuntimeError("Python notice must remain inside the source checkout")
    content = original.read_text(encoding="utf-8").replace("\r\n", "\n")
    if hashlib.sha256(content.encode("utf-8")).hexdigest() != notice["sha256"]:
        raise RuntimeError("Original Python notice changed: " + override["name"])
    license_data.append((str(original), "third-party/python/" + override["name"] + "-" + override["version"]))
# PyInstaller is a build-time dependency, but its bootloader is embedded in the
# Runner executable. Keep its license, including the Bootloader Exception.
from importlib.metadata import distribution
pyinstaller_dist = distribution("pyinstaller")
pyinstaller_notices = [Path(pyinstaller_dist.locate_file(item)) for item in pyinstaller_dist.files or []
                       if item.name.upper().startswith(("COPYING", "LICENSE"))]
if not pyinstaller_notices:
    raise RuntimeError("PyInstaller license file is missing from the build environment")
for notice in pyinstaller_notices:
    license_data.append((str(notice), "third-party/python/pyinstaller-" + pyinstaller_dist.version))
license_data = sorted(set(license_data))

hidden = [
    "app.services.connector_database", "app.services.connector_database_extra",
    "pg8000.dbapi", "pymysql", "redis", "pymongo", "bson", "dns.resolver",
    "app.services.access_policy",
    "app.services.access_transition",
    "app.services.acp_transition",
    "app.services.access_broker",
    "app.services.access_command_scope",
    "app.services.acp_access",
    "app.services.access_scope", "app.services.skill_read_scope", "app.services.runtime_messages", "app.services.runtime_claude_messages",
    "app.services.opencode_access",
    "app.services.acp_agents",
    "app.services.acp_bridge",
    "app.services.harness2_runtime",
    "app.services.harness2_bridge",
    "app.services.harness2_native",
    "app.services.harness2_provider",
    "app.services.harness2_streaming",
    "app.services.harness2_session",
    "app.services.harness2_tools",
    "app.services.harness2_mcp",
    "app.services.harness2_engine",
    "app.services.agent_setup_harness2",
    "app.services.runtime_images",
    "app.services.ai_local",
    "app.services.local_base",
    "app.services.agent_setup",
    "app.services.managed_agents",
    "app.services.local_stream",
    "app.services.local_ctx",
    "app.services.ai_prompts",
    "app.services.personal_plugin_runtime",
    "app.services.ai_flow_presets",
    "app.services.execution_capabilities",
    "app.services.execution_policy",
    "app.services.local_execution_policy",
    "app.services.execution_event_policy",
    "app.services.runtime_components",
    "app.services.skills",
    "app.services.workdirs",
    "app.services.workspace_guard",
    "app.services.code_creds",
]

# winpty only exists on Windows; the macOS/Linux Runner uses the stdlib pty
# (pty_term.py), so the collected ConPTY payload must stay Windows-only.
winpty_binaries = collect_dynamic_libs("winpty") if sys.platform == "win32" else []
winpty_datas = collect_data_files("winpty") if sys.platform == "win32" else []

a = Analysis(
    [os.path.join(backend, "runner_main.py")],
    pathex=[backend],
    binaries=winpty_binaries,
    datas=(winpty_datas + [
        (os.path.join(backend, "app", "agent_catalog.json"), "app"),
        (os.path.join(backend, "app", "services", "dsh_session_storage.mjs"), "app/services"),
        (os.path.join(backend, "app", "services", "codex_gateway_startup.mjs"), "app/services"),
        (os.path.join(backend, "app", "services", "dsh_gateway_bundle"), "app/services/dsh_gateway_bundle"),
        (os.path.join(backend, "app", "services", "harness2_vendor", "LICENSE"), "app/services/harness2_vendor"),
        (os.path.join(backend, "app", "services", "harness2_vendor", "UPSTREAM.md"), "app/services/harness2_vendor"),
    ] + skill_data + license_data),
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=([
        "tkinter", "unittest", "sqlalchemy", "fastapi", "uvicorn",
        "app.services.llm", "app.db", "app.models", "pydantic", "pydantic_settings", "dotenv",
        # Hub transport authorization uses its database; the standalone Runner
        # never sends Hub-side RPCs or authenticates other Runner identities.
        "app.services.runner_access_policy",
        # Model admission belongs to Hub workers. Cluster notifications may
        # reference it lazily, but a standalone Runner has no admission DB.
        "app.services.model_runtime",
    ] + ([] if sys.platform == "win32" else ["winpty", "pywinpty"])),
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="soduwork-runner",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    exclude_binaries=False,
    disable_windowed_traceback=False,
)
