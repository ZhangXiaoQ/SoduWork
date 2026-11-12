# -*- coding: utf-8 -*-
"""Commercial office plugin contracts: normalization, bootstrap and routing."""
import asyncio
import json
import os
import sys
import io
import zipfile
from pathlib import Path

DB = os.path.abspath(".smoke-office-plugins.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace(os.sep, "/")
sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import automation_models as am  # noqa: E402
from app.db import SessionLocal, engine, init_db  # noqa: E402
from app.services import (plugin_drafts, plugin_packages, plugin_service,
                          work_catalog)  # noqa: E402

FILES = {
    "document-studio": ("document-studio.json", [], "compose.document"),
    "presentation-studio": ("presentation-studio.json", [], "design.presentation"),
    "spreadsheet-analyst": ("spreadsheet-analyst.json", [], "analyse.workbook"),
    "deep-research": ("deep-research.json", ["browser-use"], "research.report"),
    "meeting-to-action": ("meeting-to-action.json", [], "summarize.minutes"),
    "knowledge-synthesis": ("knowledge-synthesis.json", [], "synthesize.brief"),
}
OPEN_SOURCE = {
    "document-studio": ("Apache-2.0", "iOfficeAI/OfficeCLI", "fd4adab4dbe3"),
    "presentation-studio": ("Apache-2.0", "iOfficeAI/OfficeCLI", "fd4adab4dbe3"),
    "spreadsheet-analyst": ("Apache-2.0", "iOfficeAI/OfficeCLI", "fd4adab4dbe3"),
    "deep-research": ("MIT", "langchain-ai/open_deep_research", "1b7d2e80db9f"),
}

passed = failed = 0


def check(name, condition, extra=""):
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + ("  << " + str(extra) if extra else ""))


async def main():
    await init_db()
    ppt_package = plugin_drafts.build({
        "template": "method",
        "name": "季度经营汇报",
        "version": "0.1.0",
        "description": "整理经营数据并交付季度汇报 PPTX",
        "instructions": "输出可直接演示的 quarterly-review.pptx。",
    })
    with zipfile.ZipFile(io.BytesIO(ppt_package)) as archive:
        ppt_manifest = json.loads(archive.read("plugin.json"))
    check("office file extension does not inject a paid runtime",
          ppt_manifest["capabilities"]["runtime"] == [],
          ppt_manifest["capabilities"]["runtime"])

    plain_package = plugin_drafts.build({
        "template": "method",
        "name": "纯文本纪要",
        "version": "0.1.0",
        "description": "整理讨论结论",
        "instructions": "直接输出精炼的纯文本结论。",
    })
    with zipfile.ZipFile(io.BytesIO(plain_package)) as archive:
        plain_manifest = json.loads(archive.read("plugin.json"))
    check("plain work does not request office capability",
          plain_manifest["capabilities"]["runtime"] == [],
          plain_manifest["capabilities"]["runtime"])

    workflow_package = plugin_drafts.build({
        "template": "workflow",
        "name": "路演材料",
        "version": "0.1.0",
        "description": "生成路演材料",
        "instructions": "按节点完成材料制作。",
        "workflow": {"nodes": [{
            "key": "slides", "type": "ai", "name": "制作演示",
            "outputs": [{"key": "deck", "kind": "file",
                         "path": "deliverables/pitch.pptx"}],
            "capabilities": {"skills": [], "mcpServers": [], "runtime": []},
            "config": {"prompt": "制作交付物"},
        }]},
    })
    with zipfile.ZipFile(io.BytesIO(workflow_package)) as archive:
        workflow = json.loads(archive.read("workflow.json"))
    check("office file output does not inject a node authorization",
          workflow["nodes"][0]["capabilities"]["runtime"] == [],
          workflow["nodes"][0]["capabilities"]["runtime"])

    parsed = {}
    for key, (filename, skill, expected_output) in FILES.items():
        with (Path(__file__).resolve().parents[1] / "plugins" / filename).open(encoding="utf-8") as handle:
            raw = json.load(handle)
        manifest, workflow, report = plugin_packages.normalize(raw)
        parsed[key] = (manifest, workflow, report)
        nodes = list(workflow.get("nodes") or [])
        node_types = [node.get("type") for node in nodes]
        contract_ids = {item.get("id") for item in report.get("resultContract") or []}
        cases = list(report.get("evaluationCases") or [])
        check(key + " normalizes", manifest.get("key") == key, manifest.get("key"))
        check(key + " is substrate neutral",
              not any((node.get("config") or {}).get("agentKind") for node in nodes))
        check(key + " declares only reviewed skills",
              report.get("skills") == skill, report.get("skills"))
        check(key + " has minimum permission runtime",
              "files" in (report.get("runtime") or []), report.get("runtime"))
        check(key + " has independent AI review",
              "ai_review" in node_types and "human_review" in node_types)
        check(key + " has a publication evaluation",
              len(cases) == 1 and expected_output in cases[0].get("expectedOutputs", []),
              cases)
        check(key + " evaluation targets a real result contract",
              expected_output in contract_ids, sorted(contract_ids))
        check(key + " supports conversation and task",
              manifest["entrypoints"]["conversation"]
              and manifest["entrypoints"]["task"])
        source = manifest.get("openSource") or {}
        if key in OPEN_SOURCE:
            license_id, repository, revision = OPEN_SOURCE[key]
            check(key + " exposes truthful open-source provenance",
                  source.get("license") == license_id
                  and repository in source.get("repository", "")
                  and revision in source.get("upstreamVersion", ""),
                  source)
        else:
            check(key + " does not fake an open-source label", not source, source)

    check("all plugin keys are unique", len(parsed) == len(FILES))
    check("only deep research requests network",
          all(bool(report.get("network")) == (key == "deep-research")
              for key, (_manifest, _workflow, report) in parsed.items()))
    check("office deliverables require no proprietary or paid office skill",
          all("office" not in (report.get("skills") or [])
              and "office" not in (report.get("runtime") or [])
              for key, (_manifest, _workflow, report) in parsed.items()
              if key != "deep-research"))
    invalid = False
    try:
        plugin_packages.normalize({
            "schemaVersion": 1, "key": "bad-license", "name": "错误许可证",
            "version": "0.1.0", "instructions": "完成任务。",
            "openSource": {
                "license": "AGPL-3.0",
                "repository": "https://github.com/example/project",
            },
        })
    except ValueError:
        invalid = True
    check("copyleft source cannot be disguised as a commercial built-in", invalid)

    async with SessionLocal() as session:
        await plugin_service.bootstrap_example(session)
        discovered = set(FILES) | {"delivery-audit"}
        rows = list((await session.execute(select(am.Plugin).where(
            am.Plugin.key.in_(discovered)))).scalars().all())
        check("bootstrap discovers office and delivery-audit plugins", len(rows) == len(discovered),
              [row.key for row in rows])
        versions = list((await session.execute(select(am.PluginVersion).where(
            am.PluginVersion.plugin_id.in_({row.id for row in rows}))))
            .scalars().all())
        check("each plugin has one immutable version", len(versions) == len(discovered),
              len(versions))
        check("new built-ins enter quarantine",
              all(row.trust_state == "quarantined" and not row.enabled
                  for row in versions))

        await plugin_service.bootstrap_example(session)
        repeated = list((await session.execute(select(am.PluginVersion).where(
            am.PluginVersion.plugin_id.in_({row.id for row in rows}))))
            .scalars().all())
        check("bootstrap is idempotent and does not approve discovered versions",
              {row.id for row in repeated} == {row.id for row in versions}
              and all(row.trust_state == "quarantined" and not row.enabled
                      for row in repeated))

        await work_catalog.bootstrap(session)
        scenarios = {row.key: row for row in
                     await work_catalog.scenario_rows(session, None)}
        expected_routes = {
            "document-authoring": "document-studio",
            "presentation-production": "presentation-studio",
            "spreadsheet-analysis": "spreadsheet-analyst",
            "research-analysis": "deep-research",
            "meeting-followup": "meeting-to-action",
            "knowledge-synthesis": "knowledge-synthesis",
        }
        check("all six specialist scenarios exist",
              set(expected_routes).issubset(scenarios), sorted(scenarios))
        check("specialist scenarios target their professional plugins",
              all(scenarios[key].default_plugin_key == plugin
                  for key, plugin in expected_routes.items()))

    print("\noffice plugins smoke: %d passed, %d failed" % (passed, failed))
    return 1 if failed else 0


async def run():
    try:
        return await main()
    finally:
        await engine.dispose()


try:
    code = asyncio.run(run())
finally:
    for suffix in ("", "-shm", "-wal"):
        try:
            os.remove(DB + suffix)
        except FileNotFoundError:
            pass
sys.exit(code)
