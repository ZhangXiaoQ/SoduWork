"""Transport inert, hash-checked plugin files to the actual execution machine.

The original approved package remains immutable. Metadata/connector configuration
is handled separately; executable files are stored but never run during install.
"""
from __future__ import annotations

import base64
import io
import os
import zipfile

from . import plugin_resources

PREFIX = "references/plugin-package/"
METADATA = {
    "plugin.json", "workflow.json", "soduwork/workflow.json", "soduwork/workflow.json",
    ".mcp.json", "mcp.json", ".app.json", "plugin-signature.json",
    "signature.json", "hooks/hooks.json",
}


def build(parsed: dict) -> dict:
    report = dict(parsed.get("capabilities") or {})
    root = str(parsed.get("archiveRoot") or "")
    excluded = METADATA | set(parsed.get("excludedResourcePaths") or [])
    files = []
    with zipfile.ZipFile(io.BytesIO(parsed["bytes"])) as archive:
        for info in archive.infolist():
            name = info.filename.replace("\\", "/")
            if info.is_dir() or not name.startswith(root):
                continue
            relative = name[len(root):]
            # Control/configuration files are not runtime resources. In particular,
            # never copy MCP headers/env or automatically register imported hooks.
            if (relative in excluded or relative.startswith(("soduwork/", "soduwork/"))
                    or any(part.startswith(".") for part in relative.split("/"))):
                continue
            kind = ("script" if "/scripts/" in "/" + relative
                    else "asset" if "/assets/" in "/" + relative else "reference")
            files.append({
                "path": PREFIX + relative, "kind": kind, "encoding": "base64",
                "content": base64.b64encode(archive.read(info)).decode("ascii"),
            })
    resources = plugin_resources.normalize(files)
    paths = {item["path"] for item in resources}
    skills = []
    for item in report.get("bundledSkills") or []:
        original = str(item.get("archivePath") or "")
        path = PREFIX + original[len(root):]
        if not original.startswith(root) or path not in paths:
            raise ValueError("插件技能正文缺失，不能以截断内容替代：" + str(item.get("name")))
        skills.append({"name": str(item.get("name") or ""),
                       "description": str(item.get("description") or ""),
                       "path": path})
    return {"resources": resources, "skills": skills,
            "digest": plugin_resources.digest(resources)}


def index(bundle: dict) -> str:
    rows = bundle.get("skills") or []
    if not rows:
        return ""
    return ("技能正文与配套文件已完整保留在本轮插件资源目录。先按用途选择技能，"
            "再完整读取对应 SKILL.md；按其说明读取引用或使用脚本，不能只凭目录摘要执行。\n"
            + "\n".join("- " + row["name"] + "：" + row["path"]
                        for row in rows))


def for_version(version) -> dict:
    from . import plugin_packages
    path = str(version.package_path or "")
    from . import product_brand
    manifest, report, proof = (dict(version.manifest or {}),
                               dict(version.capability_report or {}),
                               dict(version.provenance or {}))
    source = str(proof.get("sourceName") or "")
    # Built-in JSON templates have no archive resources. Their stored immutable
    # manifest/workflow is authoritative; a later release replaces the source JSON.
    # ZIP packages (including historical signed platform packs) still validate bytes below.
    if (product_brand.builtin_version(version) and source == manifest.get("key", "") + ".json"
            and os.path.basename(path) == source and proof.get("sourceKind") == "builtin"
            and not any(data.get(key) for data in (manifest, report)
                        for key in ("bundledSkills", "resources", "runtimeResources"))):
        return {"resources": [], "skills": [], "digest": plugin_resources.digest([])}
    if not path:
        if dict(version.capability_report or {}).get("bundledSkills"):
            raise ValueError("插件原始包缺失，请重新发布完整版本")
        return {"resources": [], "skills": [], "digest": plugin_resources.digest([])}
    if not os.path.isfile(path):
        raise ValueError("插件原始包缺失，请重新发布完整版本")
    with open(path, "rb") as stream:
        data = stream.read(plugin_packages._MAX_PACKAGE + 1)
    parsed = plugin_packages.parse(data)
    if parsed["checksum"] != version.checksum:
        raise ValueError("插件原始包校验失败，禁止加载被修改的资源")
    return parsed["resourceBundle"]


def cache_tag(version) -> str:
    import hashlib
    import json
    try:
        stat = os.stat(str(version.package_path or ""))
    except OSError as exc:
        raise ValueError("插件原始包缺失，请重新发布完整版本") from exc
    fingerprint = json.dumps([version.id, version.checksum, version.manifest,
                              stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns],
                             sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return '"' + hashlib.sha256(fingerprint.encode()).hexdigest() + '"'


def ui_for_version(version) -> dict:
    from . import plugin_packages, plugin_app_contracts
    path = str(version.package_path or '')
    if not path or not os.path.isfile(path):
        raise ValueError('插件原始包缺失，请重新发布完整版本')
    with open(path, 'rb') as stream:
        parsed = plugin_packages.parse(stream.read(plugin_packages._MAX_PACKAGE + 1))
    if parsed['checksum'] != version.checksum:
        raise ValueError('插件原始包校验失败，禁止加载被修改的资源')
    ui = dict(version.manifest or {}).get('ui') or {}
    files = [row for row in parsed.get('resources', []) if row['kind'] in ('ui', 'asset')]
    plugin_app_contracts.validate_resources(ui, files)
    result = {'ui': ui, 'resources': files}
    manifest = dict(version.manifest or {})
    if manifest.get('jiyong'):
        result.update(jiyong=manifest['jiyong'], versionId=version.id,
                      capabilities=dict(version.capability_report or {}))
    return result
