"""Adapters for third-party agent plugin packages.

The workflow engine only understands SoduWork's small, versioned manifest.  Import adapters
translate package metadata into that contract; they never execute third-party hooks or code.
"""
from __future__ import annotations

import json
import re
import zipfile


_MANIFEST_SUFFIX = {
    "codex": ".codex-plugin/plugin.json",
    "claude": ".claude-plugin/plugin.json",
}
PORTABLE_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
_SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$")


def _json(zf: zipfile.ZipFile, info: zipfile.ZipInfo, label: str) -> dict:
    try:
        value = json.loads(zf.read(info).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label}不是有效的 UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label}必须是 JSON 对象")
    return value


def _scalar(value, limit: int = 600) -> str:
    if isinstance(value, dict):
        value = value.get("name") or value.get("displayName") or ""
    return str(value or "").strip()[:limit]


def _key(value: str, digest: str) -> str:
    value = re.sub(r"^@[^/]+/", "", str(value or "").strip().lower())
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")[:63]
    if not value or not value[0].isalpha():
        value = "plugin-" + (value or digest[:10])
    if len(value) < 2:
        value = "plugin-" + value
    return value[:63].rstrip("-")


def _version(value, digest: str, warnings: list[str]) -> str:
    raw = str(value or "").strip()
    if _SEMVER.fullmatch(raw):
        return raw
    if re.fullmatch(r"[0-9]+\.[0-9]+", raw):
        return raw + ".0"
    if raw:
        warnings.append(f"原包版本「{raw}」不是 SemVer，SoduWork 已按内容生成不可变版本号")
    else:
        warnings.append("原包没有版本号，SoduWork 已按内容生成不可变版本号")
    return "0.0.0+" + digest[:12]


def _frontmatter(raw: bytes, *, source: str = "SKILL.md") -> dict:
    from .skill_frontmatter import parse
    fields = parse(raw, source=source)
    return {key: fields[key] for key in ("name", "description", "compatibility")}


def discover_skills(zf: zipfile.ZipFile, names: dict[str, zipfile.ZipInfo],
                    root: str = "", explicit=None, *, portable=False) -> tuple[list[dict], list[str]]:
    """Return safe Agent Skills entries and warnings without extracting the package."""
    root = root.rstrip("/") + ("/" if root else "")
    candidates: set[str] = set()
    root_skill = root + "SKILL.md"
    if not portable and root_skill in names:
        candidates.add(root_skill)
    prefix = root + "skills/"
    for name in names:
        if name.startswith(prefix) and name.endswith("/SKILL.md"):
            relative = name[len(prefix):]
            if relative and "/" in relative:
                candidates.add(name)
    for entry in ([explicit] if isinstance(explicit, str) else explicit or []):
        value = entry.get("path") if isinstance(entry, dict) else entry
        path = str(value or "").replace("\\", "/")
        if path.startswith("./"):
            path = path[2:]
        if path.startswith("/") or ".." in path.split("/") or ":" in path:
            raise ValueError("插件技能路径必须位于包内")
        path = path.rstrip("/")
        if not path:
            continue
        candidate = root + path
        candidates.update(name for name in names if name.startswith(candidate + "/")
                          and name.endswith("/SKILL.md"))
        if not candidate.endswith("SKILL.md"):
            candidate = candidate.rstrip("/") + "/SKILL.md"
        if candidate in names:
            candidates.add(candidate)

    out, warnings, seen = [], [], set()
    for path in sorted(candidates):
        folder = path.rsplit("/", 1)[0] if "/" in path else ""
        meta = _frontmatter(zf.read(names[path]), source=path)
        if meta["name"] in seen:
            raise ValueError(f"插件包里有重名技能：{meta['name']}")
        seen.add(meta["name"])
        out.append({**meta, "archivePath": path, "archivePrefix": folder,
                    "rootSkill": path == root_skill})
    return out, warnings


def _workflow(zf, names, root: str) -> dict | None:
    for suffix in ("soduwork/workflow.json", "soduwork/workflow.json"):
        path = root + suffix
        if path in names:
            return _json(zf, names[path], "工作流清单")
    return None


def _components(raw: dict, names: dict[str, zipfile.ZipInfo], root: str) -> list[str]:
    found = set()
    checks = {
        "commands": ("commands/",),
        "agents": ("agents/",),
        "hooks": ("hooks/",),
        "workflows": ("workflows/",),
        "后台监控": ("monitors/",),
        "可执行文件": ("bin/",),
        "MCP 配置": (".mcp.json", "mcp.json"),
        "已注册 MCP 应用": (".app.json",),
        "LSP 配置": (".lsp.json",),
        "输出样式": ("output-styles/",),
        "主题": ("themes/",),
    }
    for label, suffixes in checks.items():
        if any(name.startswith(root + suffix) for name in names for suffix in suffixes):
            found.add(label)
    for key, label in (("commands", "commands"), ("agents", "agents"),
                       ("hooks", "hooks"), ("mcpServers", "MCP 配置"),
                       ("apps", "已注册 MCP 应用"), ("lspServers", "LSP 配置"),
                       ("workflows", "workflows"), ("monitors", "后台监控"),
                       ("outputStyles", "输出样式")):
        if raw.get(key):
            found.add(label)
    return sorted(found)


def _mcp_keys(value) -> list[str]:
    if not isinstance(value, dict):
        return []
    servers = value.get("mcpServers") or value.get("mcp_servers") or value
    if not isinstance(servers, dict):
        return []
    return sorted({str(key).strip()[:128] for key, config in servers.items()
                   if str(key).strip() and not str(key).startswith("$")
                   and isinstance(config, dict)})[:50]


def discover_mcp_names(zf: zipfile.ZipFile, names: dict[str, zipfile.ZipInfo],
                       root: str, declared) -> tuple[list[str], list[str]]:
    """Import logical MCP names only; executable config and credentials never cross over."""
    found, warnings = set(), []
    values = declared if isinstance(declared, list) else [declared]
    for value in values:
        found.update(_mcp_keys(value))
    paths = [root + ".mcp.json"] if root + ".mcp.json" in names else []
    for value in values:
        if not isinstance(value, str):
            continue
        relative = value.replace("\\", "/").strip()
        if relative.startswith("./"):
            relative = relative[2:]
        if not relative or relative.startswith("/") or ".." in relative.split("/"):
            raise ValueError("第三方插件 MCP 配置路径必须位于插件目录内")
        candidate = root + relative
        if candidate not in names:
            raise ValueError("第三方插件声明的 MCP 配置不存在：" + relative)
        paths.append(candidate)
    for path in dict.fromkeys(paths):
        found.update(_mcp_keys(_json(zf, names[path], "MCP 配置")))
    if found:
        warnings.append("MCP 只导入逻辑连接名；命令、地址、环境变量和密钥需由管理员在 SoduWork 中重新配置")
    return sorted(found), warnings


def detect(names: dict[str, zipfile.ZipInfo]) -> tuple[str, str] | None:
    matches = []
    for source, suffix in _MANIFEST_SUFFIX.items():
        for name in names:
            if name == suffix or name.endswith("/" + suffix):
                matches.append((source, name))
    if not matches:
        return None
    roots = {name[:-len(_MANIFEST_SUFFIX[source])] for source, name in matches}
    if len(roots) != 1:
        raise ValueError("插件包包含多个 Codex/Claude 清单，无法确定导入入口")
    # Same-package overlays are compatible; different package roots are ambiguous.
    return sorted(matches, key=lambda item: item[0] != "codex")[0]


def skill_bundle_root(names: dict[str, zipfile.ZipInfo]) -> str | None:
    """Detect a manifest-free Claude plugin that relies on default Skill discovery."""
    roots = set()
    for name in names:
        if name == "SKILL.md":
            roots.add("")
            continue
        match = re.match(r"^(.*)skills/[^/]+/SKILL\.md$", name)
        if match:
            roots.add(match.group(1))
            continue
        if name.endswith("/SKILL.md"):
            roots.add(name[:-len("SKILL.md")])
    return next(iter(roots)) if len(roots) == 1 else None


def adapt_skill_bundle(zf: zipfile.ZipFile, names: dict[str, zipfile.ZipInfo],
                       root: str, digest: str) -> dict:
    """Convert Claude's valid manifest-free Skill layout into SoduWork's safe contract."""
    skills, warnings = discover_skills(zf, names, root)
    if not skills:
        raise ValueError("无清单插件里没有可识别的 Agent Skill")
    folder = root.rstrip("/").rsplit("/", 1)[-1] if root else ""
    display_name = folder or skills[0]["name"] or "Claude Skill 插件"
    warnings.insert(0, "原包未提供 plugin.json，SoduWork 已按 Claude Code 默认目录发现 Skill")
    names_text = "、".join(item["name"] for item in skills)
    manifest = {
        "schemaVersion": 1,
        "key": _key(display_name, digest),
        "name": display_name,
        "version": _version("", digest, warnings),
        "description": "从无清单 Claude Code 插件导入的 Agent Skill",
        "author": "",
        "inputs": [],
        "outputs": [],
        "instructions": (
            f"使用本插件提供的「{names_text}」完成当前请求。先阅读匹配技能的 SKILL.md，"
            "严格执行其中方法与质量标准，只调用已经授权的连接，并交付可验证结果。"),
        "entrypoints": {"conversation": True, "task": True, "automation": False},
        "capabilities": {"skills": [item["name"] for item in skills]},
    }
    return {"manifest": manifest, "workflow": None, "sourceKind": "claude", "archiveRoot": root,
            "bundledSkills": skills, "warnings": warnings,
            "blockers": [], "unsupportedComponents": []}


def adapt(zf: zipfile.ZipFile, names: dict[str, zipfile.ZipInfo],
          source: str, manifest_path: str, digest: str) -> dict:
    raw = _json(zf, names[manifest_path], f"{source} 插件清单")
    portable = source == "agent-plugins"
    suffix = "plugin.json" if portable else _MANIFEST_SUFFIX[source]
    root = manifest_path[:-len(suffix)]
    overlay = raw
    if portable:
        if raw.get("$schema") != PORTABLE_SCHEMA:
            raise ValueError("不支持这个 Agent Plugins schema 版本")
        extensions = raw.get("extensions", {})
        if not isinstance(extensions, dict):
            raise ValueError("插件 extensions 必须是 JSON 对象")
        extension = extensions.get("com.openai")
        if "com.openai" in extensions and not isinstance(extension, dict):
            raise ValueError("插件 com.openai 扩展必须是 JSON 对象")
        fallback = root + _MANIFEST_SUFFIX["codex"]
        overlay = (extension if isinstance(extension, dict) else
                   _json(zf, names[fallback], "Codex 兼容清单") if fallback in names else {})
    interface = overlay.get("interface") if isinstance(overlay.get("interface"), dict) else {}
    warnings: list[str] = []
    skills, skill_warnings = discover_skills(
        zf, names, root, None if portable else raw.get("skills"), portable=portable)
    warnings.extend(skill_warnings)
    components = _components(overlay, names, root)
    mcp_names = names
    declared_mcp = raw.get("mcpServers")
    if portable:
        # The portable MCP component cannot be replaced by compatibility settings.
        mcp_names = {key: value for key, value in names.items() if key != root + ".mcp.json"}
        declared_mcp = "./mcp.json" if root + "mcp.json" in names else None
    mcp_servers, mcp_warnings = discover_mcp_names(
        zf, mcp_names, root, declared_mcp)
    config_paths = [
        value.replace("\\", "/").removeprefix("./")
        for value in (declared_mcp if isinstance(declared_mcp, list) else [declared_mcp])
        if isinstance(value, str)
    ]
    warnings.extend(mcp_warnings)
    if mcp_servers:
        components = [item for item in components if item != "MCP 配置"]
    if components:
        warnings.append("暂不自动执行第三方组件：" + "、".join(components))
    workflow = _workflow(zf, names, root)
    blockers = []
    if workflow is None and not skills and not mcp_servers:
        blockers.append("包内没有可用的 Agent Skill、MCP 连接或 soduwork/workflow.json")
    names_text = "、".join(x["name"] for x in skills) or "包内能力"
    instructions = (
        f"使用本插件提供的「{names_text}」完成当前请求。先阅读匹配技能的 SKILL.md，"
        "严格执行其中方法与质量标准，只调用已经授权的连接，并交付可验证结果。") if skills else (
        "使用插件声明且已经授权的 MCP 连接处理当前请求，先发现真实工具和参数，"
        "再在用户授权范围内调用；连接未就绪时说明需要配置，不得编造执行结果。")
    display_name = (_scalar(interface.get("displayName"), 120)
                    or _scalar(raw.get("displayName"), 120)
                    or _scalar(raw.get("name"), 120) or f"{source.title()} 插件")
    description = (_scalar(interface.get("shortDescription"), 600)
                   or _scalar(raw.get("description"), 600)
                   or "从第三方 Agent 插件导入的方法")
    author = _scalar(raw.get("author"), 120)
    key = _key(_scalar(raw.get("name"), 120) or display_name, digest)
    manifest = {
        "schemaVersion": 1, "key": key, "name": display_name,
        "version": _version(raw.get("version"), digest, warnings),
        "description": description, "author": author,
        "inputs": [], "outputs": [],
        "instructions": instructions,
        "entrypoints": {
            "conversation": True, "task": True,
            "automation": bool(workflow),
        },
        "capabilities": {"skills": [x["name"] for x in skills],
                         "mcpServers": mcp_servers, "network": bool(mcp_servers)},
    }
    return {
        "manifest": manifest, "workflow": workflow, "sourceKind": source,
        "archiveRoot": root,
        "excludedResourcePaths": config_paths,
        "bundledSkills": skills, "warnings": warnings,
        "blockers": blockers, "unsupportedComponents": components,
    }
