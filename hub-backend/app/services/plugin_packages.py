"""Parse plugin ZIP packages and perform static security checks. Import enters quarantine; it does
not grant trust or enable execution.
"""
from __future__ import annotations
import hashlib
import io
import json
import os
import re
import stat
import tempfile
import unicodedata
import zipfile

from . import (execution_capabilities, execution_policy, plugin_adapters,
               plugin_input_contracts, plugin_route_contracts,
               preflight_evidence,
               plugin_setup_contracts, plugin_signatures, plugin_skill_cache,
               plugin_ui_contracts, plugin_icons, plugin_window_contracts,
               workflow_contracts)
from . import plugin_platforms
from . import plugin_app_contracts
from . import plugin_covers
from .plugin_builtin import is_virtual_mcp
from .plugin_manifest import (
    _KEY,
    _NODE_KEY,
    _VERSION,
    NODE_TYPES,
    _text,
    _CAPABILITY_NAME,
    _ENV_NAME,
    _SECRET_FIELD,
    _capability_names,
    _manifest_capabilities,
    _entrypoints,
    _node_capabilities,
    _PERMISSIVE_LICENSES,
    _PROCESS_SCOPES,
    _process,
    process_profile,
    _open_source,
    _has_secret_field,
    _evaluation_cases,
    _capability_report,
    _dag,
    normalize,
)


_MAX_PACKAGE = 10 * 1024 * 1024
_MAX_UNPACKED = 30 * 1024 * 1024
_MAX_FILES = 300


def _safe_zip(info: zipfile.ZipInfo) -> bool:
    name = info.filename.replace("\\", "/")
    if not name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        return False
    parts = name.rstrip("/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        return False
    # Require package paths portable across Windows, macOS, and Linux.
    # Reject case and trailing-dot collisions that resolve to the same file on some platforms.
    reserved = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$", re.I)
    if any((part[-1:] in (" ", ".") or re.search(r'[<>:"|?*\x00-\x1f]', part)
            or reserved.fullmatch(part)) for part in parts):
        return False
    mode = (info.external_attr >> 16) & 0xFFFF
    return not stat.S_ISLNK(mode)


def _portable_zip_name(name: str) -> str:
    return unicodedata.normalize("NFC", name.replace("\\", "/")).casefold()


def _canonical_digest(zf: zipfile.ZipFile, names: dict[str, zipfile.ZipInfo],
                      excluded: set[str] | None = None) -> str:
    """Package identity ignores zip timestamps, compression and entry order."""
    digest = hashlib.sha256()
    skipped = excluded or set()
    for name in sorted(names):
        if name in skipped:
            continue
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(zf.read(names[name]))
        digest.update(b"\0")
    return digest.hexdigest()


def parse_file(filename: str) -> dict:
    """Read and validate a stored package with the same bounded import contract."""
    with open(filename, "rb") as stream:
        return parse(stream.read(_MAX_PACKAGE + 1))


def parse(data: bytes) -> dict:
    if not data or len(data) > _MAX_PACKAGE:
        raise ValueError("插件包为空或超过 10MB")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ValueError("插件包不是有效的 ZIP 压缩包") from e
    infos = zf.infolist()
    if len(infos) > _MAX_FILES or sum(x.file_size for x in infos) > _MAX_UNPACKED:
        raise ValueError("插件包文件过多或解压后超过 30MB")
    if any(not _safe_zip(info) for info in infos):
        raise ValueError("插件包包含越界路径或符号链接")
    file_infos = [x for x in infos if not x.is_dir()]
    names = {x.filename.replace("\\", "/"): x for x in file_infos}
    if len(names) != len(file_infos):
        raise ValueError("插件包包含重复文件路径")
    if len({_portable_zip_name(name) for name in names}) != len(names):
        raise ValueError("插件包包含跨平台会冲突的文件路径")
    checksum = _canonical_digest(zf, names)
    content_checksum = _canonical_digest(
        zf, names, {plugin_signatures.SIGNATURE_PATH})
    manifest_name = "plugin.json" if "plugin.json" in names else (
        "soduwork/plugin.json" if "soduwork/plugin.json" in names else "")
    if not manifest_name:
        portable_roots = []
        for name in names:
            if name.count("/") == 1 and name.endswith("/plugin.json"):
                candidate = plugin_adapters._json(zf, names[name], "插件清单")
                if str(candidate.get("$schema") or "").startswith("https://agent-plugins.org/"):
                    portable_roots.append(name)
        if len(portable_roots) > 1:
            raise ValueError("插件包包含多个 portable 插件入口")
        manifest_name = portable_roots[0] if portable_roots else ""
    adapter = None
    if manifest_name:
        try:
            manifest = json.loads(zf.read(names[manifest_name]).decode("utf-8"))
            workflow = None
            workflow_name = (manifest_name.rsplit("/", 1)[0] + "/workflow.json"
                             if "/" in manifest_name else "workflow.json")
            if workflow_name in names:
                workflow = json.loads(zf.read(names[workflow_name]).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ValueError("插件清单不是有效的 UTF-8 JSON") from e
        if not isinstance(manifest, dict):
            raise ValueError("插件清单必须是 JSON 对象")
        if str(manifest.get("$schema") or "").startswith("https://agent-plugins.org/"):
            adapter = plugin_adapters.adapt(
                zf, names, "agent-plugins", manifest_name, checksum)
        else:
            from . import plugin_personal_resources
            prefix = manifest_name.rsplit("/", 1)[0] + "/" if "/" in manifest_name else ""
            bundled, warnings = plugin_adapters.discover_skills(
                zf, plugin_personal_resources.discovery_files(names, manifest, prefix))
            adapter = {
                "manifest": manifest, "workflow": workflow,
                "sourceKind": "adapter" if manifest_name.startswith("soduwork/") else "soduwork",
                "bundledSkills": bundled, "warnings": warnings,
                "blockers": [], "unsupportedComponents": [],
            }
    else:
        detected = plugin_adapters.detect(names)
        if detected:
            adapter = plugin_adapters.adapt(zf, names, *detected, checksum)
        else:
            root = plugin_adapters.skill_bundle_root(names)
            if root is not None:
                adapter = plugin_adapters.adapt_skill_bundle(zf, names, root, checksum)
    if adapter is None:
        raise ValueError(
            "找不到 SoduWork、Codex 或 Claude 插件入口（plugin.json / "
            ".codex-plugin/plugin.json / .claude-plugin/plugin.json / skills/*/SKILL.md）")
    normalized, wf, report = normalize(adapter["manifest"], adapter.get("workflow"))
    from . import plugin_resources
    resource_prefix = manifest_name.rsplit('/', 1)[0] + '/' if '/' in manifest_name else ''
    resources = plugin_resources.from_archive(
        adapter['manifest'].get('resources'), zf, resource_prefix, normalized['key'])
    plugin_app_contracts.validate_resources(normalized.get('ui'), resources)
    if normalized.get('jiyong',{}).get('initialization'):
        from . import jiyong_initialization
        jiyong_initialization.parse(normalized['jiyong'],resources)
    if resources:
        normalized['resources'] = plugin_resources.summary(resources)
        report['resources'] = normalized['resources']
    report = _capability_report(report, adapter, normalized, wf)
    signature_info = plugin_signatures.parse_envelope(
        zf.read(names[plugin_signatures.SIGNATURE_PATH])
        if plugin_signatures.SIGNATURE_PATH in names else None,
        content_checksum, normalized)
    parsed = {"checksum": checksum, "manifest": normalized,
            "workflow": wf, "capabilities": report,
            "contentChecksum": content_checksum, "signature": signature_info,
            "sourceKind": adapter["sourceKind"],
            "archiveRoot": adapter.get("archiveRoot", resource_prefix),
            "excludedResourcePaths": list(adapter.get("excludedResourcePaths") or []),
            "resources": resources,
            "bytes": data}
    # Validate the exact runtime files before installation/publication, not only
    # when the first conversation is started. Never silently truncate a package.
    from . import plugin_package_resources
    parsed["resourceBundle"] = plugin_package_resources.build(parsed)
    report["runtimeResources"] = plugin_resources.summary(parsed["resourceBundle"]["resources"])
    if (adapter["sourceKind"] in {"codex", "claude", "agent-plugins"}
            or (report.get("bundledSkills") and not resources)):
        report["resources"] = report["runtimeResources"]
    return parsed


def package_root() -> str:
    from .local_base import _data_root
    path = os.path.join(_data_root(), "plugins")
    os.makedirs(path, exist_ok=True)
    return path


def _stored_checksum(path: str) -> str:
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as stored:
            for chunk in iter(lambda: stored.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return ""
    return digest.hexdigest()


def store(parsed: dict) -> str:
    key = parsed["manifest"]["key"]
    checksum = parsed["checksum"]
    content_checksum = hashlib.sha256(parsed["bytes"]).hexdigest()
    folder = os.path.join(package_root(), key)
    os.makedirs(folder, exist_ok=True)
    # Preserve existing content-addressed paths; new packages use the current brand.
    for suffix in (".soduwork-plugin", ".soduwork-plugin", ".soduwork-plugin"):
        existing = os.path.join(folder, checksum + suffix)
        if os.path.isfile(existing):
            if _stored_checksum(existing) != content_checksum:
                raise RuntimeError("Stored plugin package checksum does not match its identity")
            return existing
    path = os.path.join(folder, checksum + ".soduwork-plugin")

    # Publish a fully written file atomically. A hard link never replaces a
    # concurrent winner; filesystems without link support use replace and then
    # verify the content-addressed target before accepting the race.
    fd, tmp = tempfile.mkstemp(prefix=".plugin-", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "wb") as pending:
            pending.write(parsed["bytes"])
            pending.flush()
            os.fsync(pending.fileno())
        try:
            os.link(tmp, path)
        except FileExistsError:
            pass
        except OSError:
            try:
                os.replace(tmp, path)
            except OSError:
                if _stored_checksum(path) != content_checksum:
                    raise
        if _stored_checksum(path) != content_checksum:
            raise RuntimeError("Stored plugin package checksum does not match its identity")
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return path


def personal_draft(parsed: dict) -> dict:
    """Create a local draft; keep complete supported files inert and hash-checked.

    Third-party hooks and connector credentials are never activated or copied as
    runtime configuration. Scripts referenced by skills remain ordinary files.
    """
    manifest = dict(parsed.get("manifest") or {})
    report = dict(parsed.get("capabilities") or {})
    workflow = dict(parsed.get("workflow") or {})
    chunks: list[str] = []

    def add(title: str, value, limit: int) -> None:
        text = str(value or "").replace("\x00", "").strip()[:limit]
        if text:
            chunks.append(("## " + title + "\n" + text)[:limit + len(title) + 4])

    add("插件工作说明", manifest.get("instructions"), 4000)
    bundled = [item for item in report.get("bundledSkills") or []
               if isinstance(item, dict)][:12]
    if bundled:
        with zipfile.ZipFile(io.BytesIO(parsed.get("bytes") or b"")) as archive:
            names = {item.filename.replace("\\", "/"): item
                     for item in archive.infolist() if not item.is_dir()}
            for item in bundled:
                archive_path = str(item.get("archivePath") or "").replace("\\", "/")
                info = names.get(archive_path)
                if info is None:
                    continue
                raw = archive.read(info)
                add("Skill：" + _text(item.get("name"), 80),
                    raw.decode("utf-8", errors="replace"), 3500)
                if sum(len(chunk) for chunk in chunks) >= 7600:
                    break
    prompts = []
    for node in list(workflow.get("nodes") or [])[:30]:
        if not isinstance(node, dict) or node.get("type") not in {"ai", "ai_review", "spec"}:
            continue
        prompt = _text(dict(node.get("config") or {}).get("prompt"), 1800)
        if prompt:
            prompts.append("### " + _text(node.get("name") or node.get("key"), 100)
                           + "\n" + prompt)
    if prompts:
        add("工作流节点方法", "\n\n".join(prompts), 3000)
    instructions = "\n\n".join(chunks).strip()[:8000]
    if not instructions:
        instructions = (
            "按照插件声明的能力和质量标准完成当前请求；说明实际执行、证据与未完成事项。")
    cases = [item for item in report.get("evaluationCases") or []
             if isinstance(item, dict)]
    representative = cases[0] if cases else {}
    has_workflow = bool(report.get("hasWorkflow"))
    mcp_servers = list(report.get("mcpServers") or [])[:30]
    external_skills = list(report.get("externalSkills") or [])[:30]
    platforms = plugin_platforms.normalize(dict(manifest.get("capabilities") or {}).get("platforms"))
    # Keep the complete workflow when every node has a portable authoring
    # contract.  Enterprise nodes are deliberately retained in the local
    # snapshot: the client can display, export and re-submit them, while its
    # local debug gate refuses to execute deployment/approval side effects.
    # Dropping these nodes here used to turn an independently authored release
    # plugin into a different generic workflow when another user imported it.
    editable_types = {
        "ai", "ai_review", "human_review", "publish",
        "spec", "quality", "approval", "merge", "deploy_chain", "validate",
    }
    editable_nodes = list(workflow.get("nodes") or [])[:30]
    editable_workflow = (
        {"nodes": json.loads(json.dumps(editable_nodes, ensure_ascii=False))}
        if has_workflow and editable_nodes
        and all(str(node.get("type") or "") in editable_types for node in editable_nodes)
        else None)
    from . import plugin_personal_resources
    portable_resources, instructions = plugin_personal_resources.prepare(parsed, instructions)
    has_cli = ("terminal" in (report.get("runtime") or [])
               and any(item.get("kind") == "script" for item in portable_resources))
    return {
        "template": "app" if manifest.get('template') == 'app' else "workflow" if has_workflow else
                    "connector" if mcp_servers or platforms or has_cli else "method",
        "key": _text(manifest.get("key"), 63),
        "name": _text(manifest.get("name"), 120),
        "version": _text(manifest.get("version"), 40),
        "description": _text(manifest.get("description"), 600),
        **({'locales': manifest['locales']} if manifest.get('locales') else {}),
        "author": _text(manifest.get("author"), 120),
        **({"appCategory": manifest["appCategory"]} if manifest.get("appCategory") is not None else {}),
        **({"extensions": manifest["extensions"]} if manifest.get("extensions") is not None else {}),
        **({"distribution": _text(manifest.get("distribution"), 24)}
           if _text(manifest.get("distribution"), 24) else {}),
        **({'coverUrl': plugin_covers.normalize(manifest['coverUrl'])} if manifest.get('coverUrl') else {}),
        **({'icon': plugin_icons.normalize(manifest['icon'])} if manifest.get('icon') else {}),
        **({'appWindow': plugin_window_contracts.normalize(manifest['appWindow'])} if manifest.get('appWindow') is not None else {}),
        **({'jiyong': manifest['jiyong']} if manifest.get('jiyong') else {}),
        "instructions": instructions,
        "inputs": list(manifest.get("inputs") or [])[:50],
        "setup": dict(manifest.get("setup") or {}),
        "ui": dict(manifest.get("ui") or {}),
        "entrypoints": dict(manifest.get("entrypoints") or {}),
        **({"platforms": platforms} if platforms else {}),
        **({'resources': portable_resources} if portable_resources else {}),
        "skills": external_skills,
        "mcpServers": mcp_servers,
        "runtimeCapabilities": list(report.get("runtime") or [])[:30],
        "evaluationInstruction": _text(representative.get("instruction"), 2000),
        "evaluationCriteria": list(representative.get("criteria") or [])[:20],
        "sourceKind": _text(parsed.get("sourceKind"), 32),
        "importChecksum": _text(parsed.get("checksum"), 64),
        "importWarnings": list(report.get("adapterWarnings") or [])[:20],
        "unsupportedComponents": list(report.get("unsupportedComponents") or [])[:30],
        **({"workflow": editable_workflow} if editable_workflow else {}),
    }


def public_summary(parsed: dict, signature_proof: dict | None = None) -> dict:
    """Safe import preview. Raw package bytes and server paths never leave the backend."""
    report = dict(parsed["capabilities"] or {})
    public_workflow = parsed["workflow"] if report.get("hasWorkflow", True) else {"nodes": []}
    return {
        "checksum": parsed["checksum"], "sourceKind": parsed["sourceKind"],
        "signature": signature_proof or plugin_signatures.public_signature(
            parsed.get("signature")),
        "manifest": parsed["manifest"], "workflow": public_workflow,
        "capabilities": report, "personalDraft": personal_draft(parsed),
        "checks": [
            {"key": "archive", "ok": True, "label": "压缩包结构安全"},
            {"key": "manifest", "ok": True, "label": "清单与版本可识别"},
            {"key": "signature",
             "ok": str((signature_proof or {}).get("state") or "present")
                   not in {"invalid", "revoked-key"},
             "label": (
                 "发布者签名已验证"
                 if (signature_proof or {}).get("state") == "verified"
                 else "未提供签名，发布前仍需人工审核"
                 if not parsed.get("signature")
                 else "签名已识别，等待匹配可信发布者")},
            {"key": "execution", "ok": not parsed["capabilities"].get("adapterBlockers"),
             "label": ("工作流可执行" if parsed["capabilities"].get("hasWorkflow")
                       else "能力可直接调用")},
            {"key": "quality", "ok": bool(parsed["capabilities"].get("evaluationCases")),
             "label": (f"已声明 {len(parsed['capabilities'].get('evaluationCases') or [])} 个发布评测"
                       if parsed["capabilities"].get("evaluationCases")
                       else "已有结果契约，尚未声明发布评测")},
        ],
    }


def skill_root() -> str:
    return plugin_skill_cache.skill_root()


def materialize_skills(package_path: str, checksum: str, report: dict) -> list[dict]:
    return plugin_skill_cache.materialize_skills(
        package_path, checksum, report, safe_zip=_safe_zip,
        canonical_digest=_canonical_digest, max_files=_MAX_FILES,
        max_unpacked=_MAX_UNPACKED)
