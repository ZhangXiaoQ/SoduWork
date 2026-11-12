"""Deterministic smoke coverage for the enterprise capability boundary."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import tempfile
import zipfile
from pathlib import Path

# Keep imports and every generated file away from the live database.
_fixture = tempfile.TemporaryDirectory(prefix="soduwork-smoke-capabilities-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (Path(_fixture.name) / ".smoke.db").as_posix()

from fastapi import HTTPException

from app.api import capabilities as capabilities_api
from app.services import (ai_remote, capability_catalog, mcp_import, mcp_servers,
                          skill_packages, skills)


COUNT = 0


def check(value, message: str) -> None:
    global COUNT
    assert value, message
    COUNT += 1


def package(entries: list[tuple[str, bytes]], reverse: bool = False) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        rows = list(reversed(entries)) if reverse else entries
        for index, (name, data) in enumerate(rows):
            info = zipfile.ZipInfo(name, date_time=(2020 + index, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
    return buffer.getvalue()


def expect_error(fn, contains: str) -> None:
    try:
        fn()
    except ValueError as exc:
        check(contains in str(exc), "错误信息应说明：" + contains)
    else:
        raise AssertionError("预期 ValueError")


class EmptySession:
    async def get(self, _model, _key):
        return None


class Client:
    id = "u-capability-owner"
    skills = []
    mcp_servers = []
    mcp_enabled = []


class SkillSession:
    pass


async def runtime_bundle_checks(temp: str) -> None:
    skill_dir = os.path.join(temp, "portable-skill")
    local_dir = os.path.join(temp, "local-only")
    os.makedirs(skill_dir, exist_ok=True)
    os.makedirs(local_dir, exist_ok=True)
    skill_body = b"---\nname: portable-skill\ndescription: Portable.\n---\n# Method\nDo it.\n"
    with open(os.path.join(skill_dir, "SKILL.md"), "wb") as handle:
        handle.write(skill_body)
    with open(os.path.join(local_dir, "SKILL.md"), "wb") as handle:
        handle.write(skill_body.replace(b"portable-skill", b"local-only"))
    checksum = hashlib.sha256(skill_body).hexdigest()
    portable = {
        "name": "portable-skill", "description": "Portable",
        "path": skill_dir, "root": temp, "bundled": True,
        "scope": "company", "packageChecksum": checksum,
    }
    local_only = {
        "name": "local-only", "description": "Local",
        "path": local_dir, "root": temp, "bundled": False, "scope": "company",
    }
    original_cfg, original_scan = skills.load_cfg, skills.scan

    async def fake_cfg(_session):
        return {"allowed": ["portable-skill", "local-only"], "roots": []}

    skills.load_cfg = fake_cfg
    skills.scan = lambda *_args, **_kwargs: [portable, local_only]
    try:
        public = skills.public_view(portable, enabled=True)
        check("path" not in public and "root" not in public,
              "public Skill contract must not leak Hub filesystem paths")
        check(public["downloadable"] and public["enabled"],
              "portable Skill must expose download and personal selection state")
        response = await capabilities_api.materialize_my_skills(
            {"names": ["portable-skill"]}, Client(), SkillSession())
        check(response.status_code == 200 and response.media_type ==
              "application/vnd.soduwork.skills+zip",
              "runtime Skill endpoint must return the dedicated immutable payload")
        digest = hashlib.sha256(response.body).hexdigest()
        check(response.headers["x-soduwork-skill-sha256"] == digest,
              "runtime Skill digest must match the exact response bytes")
        with zipfile.ZipFile(io.BytesIO(response.body)) as archive:
            manifest = json.loads(archive.read("manifest.json"))
        check(manifest["skills"][0]["version"] == checksum,
              "runtime Skill manifest must carry the exact content version")
        local = await capabilities_api.materialize_my_skills(
            {"names": ["local-only"]}, Client(), SkillSession())
        check(local.status_code == 204,
              "local-only Skill must not fabricate a downloadable payload")
        try:
            await capabilities_api.materialize_my_skills(
                {"names": ["not-authorized"]}, Client(), SkillSession())
        except HTTPException as exc:
            check(exc.status_code == 404,
                  "unauthorized Skill must be rejected without existence disclosure")
        else:
            raise AssertionError("unauthorized Skill was distributed")
    finally:
        skills.load_cfg, skills.scan = original_cfg, original_scan


async def async_checks() -> None:
    client = Client()
    client.mcp_servers = [{
        "id": "m1", "name": "时间", "type": "stdio",
        "templateKey": "mcp-time", "approved": True,
        "approvedTarget": "mcp-time", "enabled": True,
    }]
    path, payload = await mcp_servers.runtime_for_dispatch(
        EmptySession(), client=client,
        variables={"SODUWORK_WORK_ROOT": "D:/work", "SODUWORK_WORK_DIR": "D:/work/repo"})
    check(path == "", "个人 MCP 不应额外写明文运行时文件")
    check(payload["servers"]["时间"]["command"] == "uvx", "可信模板应恢复固定命令")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="soduwork-capability-") as temp:
        os.environ["SODUWORK_DATA_ROOT"] = temp
        asyncio.run(runtime_bundle_checks(temp))
        skill = b"""---
name: company-research
description: Research with evidence and a concise decision record.
---

# Method
Collect evidence, compare options, and record the decision.
"""
        entries = [
            ("company-research/SKILL.md", skill),
            ("company-research/references/checklist.md", b"# Checklist\n"),
        ]
        first = skill_packages.parse(package(entries), "research.zip")
        second = skill_packages.parse(package(entries, reverse=True), "research-again.zip")
        check(first["checksum"] == second["checksum"],
              "内容指纹不能受 zip 顺序、时间戳和压缩方式影响")
        check(first["name"] == "company-research", "应读取标准技能名")
        check(first["resourceKinds"] == ["references"], "应识别渐进披露资源")
        check(not first["hasScripts"], "无脚本包不应误报脚本")

        own = skill_packages.install(first, "personal", "u-owner")
        check(own["bundled"], "导入 Skill 必须可随任务传给远程 Runner")
        check(len(skill_packages.active(owner_client_id="u-owner")) == 1,
              "所有者应看到个人 Skill")
        check(not skill_packages.active(owner_client_id="u-other"),
              "其他设备不能看到个人 Skill")
        company_entries = [
            ("company-standard/SKILL.md", skill.replace(
                b"name: company-research", b"name: company-standard"))]
        company = skill_packages.parse(package(company_entries), "standard.zip")
        skill_packages.install(company, "company")
        visible = skill_packages.active(owner_client_id="u-other")
        check(len(visible) == 1 and visible[0]["scope"] == "company",
              "公司 Skill 应对所有设备可发现")
        expect_error(lambda: skill_packages.install(company, "personal", "u-owner"), "同名")

        expect_error(lambda: skill_packages.parse(package([
            ("../SKILL.md", skill)])), "越界")
        expect_error(lambda: skill_packages.parse(package([
            ("a/SKILL.md", skill), ("b/SKILL.md", skill)])), "只能包含一个")
        expect_error(lambda: skill_packages.create(
            "Bad Name", "description", "instructions"), "name")
        expect_error(lambda: skill_packages.create(
            "valid-name", "description", ""), "工作方法")

        template = capability_catalog.mcp_template("mcp-filesystem")
        check(template and template["trust"] == "official", "常用 MCP 应自动进入可信目录")
        check(template["template"]["enabled"] is False, "高风险模板不能自动启用")
        check(len(capability_catalog.MCP_TEMPLATES) >= 5, "应提供一组常用官方模板")
        from unittest.mock import patch
        with patch.dict(os.environ, {"CODEX_HOME": os.path.join(temp, "configured-codex")}):
            check(os.path.join(temp, "configured-codex", "skills") in skills.default_roots(),
                  "应遵循显式 CODEX_HOME 发现 Codex Skill")
        with patch.dict(os.environ, {"CODEX_HOME": ""}):
            check(os.path.join(os.path.expanduser("~"), ".codex", "skills") in skills.default_roots(),
                  "未配置 CODEX_HOME 时应发现默认 Codex Skill")

        runner = type("Runner", (), {
            "id": "r1", "host": "设计工作站", "skills_known": True,
            "skills": ["company-research"],
        })()
        check(ai_remote._skill_preflight(runner, [{
            "name": "company-research", "bundled": False,
        }])["ok"], "目标 Runner 有同名本机 Skill 时可以执行")
        missing = ai_remote._skill_preflight(runner, [{
            "name": "private-skill", "bundled": False,
        }])
        check(not missing["ok"] and missing["missing"] == ["private-skill"],
              "目标 Runner 缺本机 Skill 时必须在派活前阻断")
        check(ai_remote._skill_preflight(runner, [{
            "name": "company-package", "bundled": True,
        }])["ok"], "主动导入的能力包可以随任务安全下发")

        trusted = mcp_servers.personal_spec({
            "name": "本机文件", "type": "stdio", "templateKey": "mcp-filesystem",
            "command": "evil.exe", "args": ["--steal"], "approved": True,
            "approvedTarget": "mcp-filesystem", "enabled": True,
        })
        check(trusted["command"] == "npx" and "evil.exe" not in trusted["command"],
              "个人端不能覆盖可信模板的本地命令")
        expect_error(lambda: mcp_servers.personal_spec({
            "name": "任意命令", "type": "stdio", "command": "cmd.exe",
            "approved": True, "approvedTarget": "arbitrary"}), "可信目录")
        expect_error(lambda: mcp_servers.personal_spec({
            "name": "未确认", "type": "http", "url": "https://mcp.example.com",
            "approved": False}), "确认")
        expect_error(lambda: mcp_servers.personal_spec({
            "name": "元数据", "type": "http", "url": "http://169.254.169.254/latest",
            "approved": True, "approvedTarget": "http://169.254.169.254/latest"}), "元数据")
        http = mcp_servers.personal_spec({
            "name": "知识库", "type": "http", "url": "https://mcp.example.com/tools",
            "headers": {"Authorization": "Bearer secret"}, "approved": True,
            "approvedTarget": "https://mcp.example.com/tools",
        })
        masked = mcp_servers.mask(http)
        check(masked["headers"]["Authorization"] == "••••", "MCP 凭据不能回显")
        restored = mcp_servers.restore(masked, http)
        check(restored["headers"]["Authorization"] == "Bearer secret",
              "遮罩值保存时应沿用旧凭据")
        expanded = mcp_servers.expand_rows([trusted], {
            "SODUWORK_WORK_ROOT": "D:/work", "SODUWORK_WORK_DIR": "D:/work/repo"})
        check(expanded[0]["args"][-1] == "D:/work", "只应替换白名单工作目录变量")

        imported_json = mcp_import.parse(json.dumps({"mcpServers": {
            "company-files": {
                "command": "npx", "args": ["-y", "server-files"],
                "env": {"ACCESS_TOKEN": "never-return-this"}},
            "company-api": {
                "type": "http", "url": "https://mcp.example.com/tools",
                "headers": {"Authorization": "Bearer never-return-this"}},
        }}).encode("utf-8"), ".mcp.json")
        json_preview = mcp_import.public_preview(imported_json, ["company-files"])
        check(json_preview["summary"]["total"] == 2, "应识别 Claude/Cowork mcpServers 清单")
        check(json_preview["summary"]["duplicates"] == 1, "预检应识别已有同名连接")
        check("never-return-this" not in repr(json_preview), "MCP 预检不得回显任何凭据值")
        merged = mcp_import.import_rows(imported_json, [{"name": "company-files"}])
        check(len(merged["imported"]) == 1 and not merged["imported"][0]["enabled"],
              "MCP 导入不得覆盖同名项且新连接必须默认停用")

        imported_toml = mcp_import.parse(b'''[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp"]\nenv_vars = ["LOCAL_TOKEN"]\n\n[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"\nhttp_headers = { X_Figma_Region = "cn" }\n''', "config.toml")
        toml_preview = mcp_import.public_preview(imported_toml)
        check(toml_preview["source"] == "Codex config.toml" and
              toml_preview["summary"]["importable"] == 1,
              "应兼容 Codex TOML，含宿主密钥引用的连接须调整后再导入")
        check(any("env_vars" in warning for warning in
                  toml_preview["servers"][0]["warnings"]),
              "无法安全复制的 Codex 环境变量引用必须明确警告")
        secret_url = mcp_import.parse(json.dumps({"mcpServers": {"unsafe": {
            "type": "http", "url": "https://mcp.example.com?token=secret"}}}).encode(),
            ".mcp.json")
        secret_preview = mcp_import.public_preview(secret_url)
        check(not secret_preview["servers"][0]["valid"] and
              "secret" not in secret_preview["servers"][0]["target"],
              "URL 内嵌凭据必须被阻止且不能出现在预览中")
        missing_url = mcp_import.parse(json.dumps({"mcpServers": {"missing": {
            "type": "http"}}}).encode(), ".mcp.json")
        check(not mcp_import.public_preview(missing_url)["servers"][0]["valid"],
              "HTTP 类型缺少 URL 时应给可读预检错误而不是让预览器崩溃")
        command_preview = mcp_import.public_preview(mcp_import.parse(json.dumps({
            "mcpServers": {"local": {"command": "C:/private/bin/npx",
                                      "args": ["--token", "never-return-this"]}}}).encode(),
            ".mcp.json"))
        check(command_preview["servers"][0]["target"] == "npx · 2 个参数" and
              "never-return-this" not in repr(command_preview),
              "stdio 预览只显示命令名和参数数量，不回显路径与参数值")

        asyncio.run(async_checks())
    print("capability smoke: %d assertions" % COUNT)


if __name__ == "__main__":
    main()
