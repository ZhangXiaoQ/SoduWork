"""Discover built-in plugins, register immutable versions, and migrate historical provenance."""
from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from . import optional_internal_features, plugin_identity, plugin_packages, scm_support

log = logging.getLogger("uvicorn.error")


def platform_archives(root: str) -> tuple[str, ...]:
    """Discover optional versioned platform archives supplied by the operator."""
    return tuple(
        str(path.relative_to(root))
        for provider in ("feishu", "dingtalk", "wecom")
        for path in sorted(path for suffix in ("*.soduwork-plugin",)
                           for path in (Path(root) / "platforms" / "releases" / provider).glob(suffix))
        if path.is_file() and not path.is_symlink()
    )


async def bootstrap_example(session: AsyncSession, provenance_api) -> None:
    """Discover built-in immutable versions; every new version still enters quarantine."""
    root = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "plugins")
    # Discover the project workflows included in this source distribution.
    for filename in (
        "ai-errand.json",
        "autonomous-dev-iterator.json",
        "deep-research.json",
        "delivery-audit.json",
        "diagram-studio.json",
        "document-studio.json",
        "engineering-delivery.json",
        "goal-delivery-harness.json",
        "knowledge-synthesis.json",
        "mcp-studio.json",
        "meeting-to-action.json",
        "pdf-toolbox.json",
        "presentation-studio.json",
        "product-incubator.json",
        "product-prototype.json",
        "project-production-release.json",
        "project-validation-release.json",
        "skill-studio.json",
        "soduwork-fast-change.json",
        "software-delivery.json",
        "spreadsheet-analyst.json",
        "viral-video-studio.json",
        "web-collect.json",
        "feishu.soduwork-plugin", "dingtalk.soduwork-plugin", "wecom.soduwork-plugin",
    ) + platform_archives(root):
        path = os.path.join(root, filename)
        if not os.path.isfile(path):
            continue
        if filename.endswith((".soduwork-plugin",)):
            try:
                with open(path, "rb") as f:
                    parsed = plugin_packages.parse(f.read(plugin_packages._MAX_PACKAGE + 1))
                relative = Path(filename)
                if len(relative.parts) > 1 and (
                        parsed["manifest"]["key"] != relative.parent.name
                        or parsed["manifest"]["version"] != relative.stem):
                    raise ValueError("Platform archive identity does not match its path")
            except (OSError, ValueError):
                log.error("内置插件包 %s 无效，已跳过登记", filename)
                continue
            manifest, workflow, report = (parsed["manifest"], parsed["workflow"],
                                          parsed["capabilities"])
            checksum = parsed["checksum"]
        else:
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
            manifest, workflow, report = plugin_packages.normalize(raw)
            checksum = hashlib.sha256(json.dumps(
                raw, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        if (scm_support.workflow_reason(workflow.get("nodes") or [])
                or optional_internal_features.workflow_missing_reason(workflow.get("nodes") or [])):
            continue
        plugin, _created_plugin = await plugin_identity.get_or_create_plugin(
            session, org_id=None, key=manifest["key"], name=manifest["name"],
            description=manifest["description"], source_kind="builtin",
            created_by="system")
        state, matched = await plugin_identity.version_state(
            session, plugin.id, manifest["version"], checksum)
        if state == "same" and matched is not None:
            proof = provenance_api(matched.provenance, matched.checksum)
            if (proof["publisherType"] != "platform"
                    or proof["channel"] != "builtin"
                    or proof["signatureState"] != "platform"):
                matched.provenance = provenance_api({
                    "publisherId": "system", "publisherName": "SoduWork 平台",
                    "publisherType": "platform", "channel": "builtin",
                    "sourceName": filename, "sourceKind": "builtin",
                    "checksum": checksum, "signatureState": "platform",
                })
            continue
        if state == "conflict":
            # Never replace an immutable version in place. A bad built-in
            # package must not stop Hub startup, but remains unavailable until
            # its semantic version is raised.
            log.error(
                "内置插件 %s 的版本号 %s 内容发生变化，已拒绝覆盖；请提升版本号",
                manifest["key"], manifest["version"])
            continue
        candidate = am.PluginVersion(
            plugin_id=plugin.id, version=manifest["version"], checksum=checksum,
            manifest=manifest, workflow=workflow, capability_report=report,
            provenance=provenance_api({
                "publisherId": "system", "publisherName": "SoduWork 平台",
                "publisherType": "platform", "channel": "builtin",
                "sourceName": filename, "sourceKind": "builtin",
                "checksum": checksum, "signatureState": "platform",
            }),
            package_path=path, trust_state="quarantined", enabled=False,
            created_by="system")
        try:
            registered, created = await plugin_identity.insert_version_once(
                session, candidate)
        except plugin_identity.PluginVersionConflict:
            log.error(
                "内置插件 %s 的版本号 %s 内容发生变化，已拒绝覆盖；请提升版本号",
                manifest["key"], manifest["version"])
            continue
        if not created:
            proof = provenance_api(registered.provenance, registered.checksum)
            if (proof["publisherType"] != "platform"
                    or proof["channel"] != "builtin"
                    or proof["signatureState"] != "platform"):
                registered.provenance = provenance_api({
                    "publisherId": "system", "publisherName": "SoduWork 平台",
                    "publisherType": "platform", "channel": "builtin",
                    "sourceName": filename, "sourceKind": "builtin",
                    "checksum": checksum, "signatureState": "platform",
                })
    await session.commit()
