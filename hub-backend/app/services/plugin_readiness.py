"""Side-effect-free plugin readiness checks and publication simulation."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am
from . import optional_internal_features, plugin_route_readiness, plugin_runtime, scm_support, workflow_contracts
from .agent_messages import descriptor


def repository_nodes(workflow: dict, node_keys: set[str] | None = None) -> list[str]:
    """Use the same repository contract for catalog warnings and actual starts."""
    nodes = list(dict(workflow or {}).get("nodes") or [])
    return sorted({str(node.get("key") or "") for node in nodes
                   if (node_keys is None or str(node.get("key") or "") in node_keys)
                   and (node.get("type") in ("quality", "merge", "script")
                        or (node.get("type") == "ai_review" and
                            workflow_contracts.ai_review_requires_code(workflow, node))
                        or any(str(output.get("kind") or "") == "git"
                               for output in node.get("outputs") or []))})


def _scoped_capability(nodes: list[dict], report: dict,
                       node_keys: set[str] | None) -> tuple[list[dict], dict]:
    if node_keys is None:
        return nodes, report
    wanted = {str(key) for key in node_keys}
    selected = [node for node in nodes if str(node.get("key") or "") in wanted]
    scoped = {"mcpServers": [], "secrets": [], "runtime": []}
    for node in selected:
        item = plugin_runtime.node_capabilities(node, report)
        for key in scoped:
            scoped[key].extend(item.get(key) or [])
    return selected, {
        key: list(dict.fromkeys(values)) for key, values in scoped.items()
    }


async def scoped_binding_readiness(session: AsyncSession, version: am.PluginVersion,
                                   project, org_id: str | None, *,
                                   secret_refs: dict | None = None,
                                   binding_config: dict | None = None,
                                   node_keys: set[str] | None = None) -> dict:
    """Apply the regular dependency checks to only the nodes that will still run."""
    from types import SimpleNamespace

    report = dict(version.capability_report or {})
    nodes, scoped = _scoped_capability(
        list(dict(version.workflow or {}).get("nodes") or []), report, node_keys)
    view = SimpleNamespace(
        workflow={**dict(version.workflow or {}), "nodes": nodes},
        capability_report={**report, **scoped},
    )
    return await binding_readiness(
        session, view, project, org_id, secret_refs=secret_refs,
        binding_config=binding_config)


async def binding_readiness(session: AsyncSession, version: am.PluginVersion,
                            project, org_id: str | None,
                            secret_refs: dict | None = None,
                            binding_config: dict | None = None, *,
                            application_context: bool = False) -> dict:
    """Report scope-specific plugin readiness at binding time, separating definite blockers from
    warnings. Do not block saving during staged setup; runtime configuration gates remain
    authoritative and allow retry after correction.
    """
    from .. import models
    nodes = list(dict(version.workflow or {}).get("nodes") or [])
    reason = scm_support.workflow_reason(nodes) or optional_internal_features.workflow_missing_reason(nodes)
    blockers: list[str] = [reason] if reason else []
    warnings: list[str] = []
    dependency_checks: list[dict] = []
    capability = dict(version.capability_report or {})
    blockers.extend(str(x) for x in capability.get("adapterBlockers") or [])
    warnings.extend(str(x) for x in capability.get("adapterWarnings") or [])

    wanted_mcp = list(capability.get("mcpServers") or [])
    if application_context:
        from . import plugin_application_mcp
        owned = plugin_application_mcp.owned_names(
            dict(getattr(version, "manifest", None) or {}), wanted_mcp)
        if owned:
            names = "、".join(sorted(owned))
            dependency_checks.append({
                "key": "app-mcp", "label": "应用 MCP 接入声明", "ok": True,
                "detail": f"已声明应用自有连接：{names}；无需重复注册企业 MCP",
                "detailMessage": descriptor("plugin.app-mcp.declared",
                    f"已声明应用自有连接：{names}；无需重复注册企业 MCP", params={"names": names}),
                "verification": "declaration",
            })
            warnings.append(
                f"应用 MCP（{names}）由 SoduWork 客户端读取已保存的应用凭据；"
                "本次只核对接入声明，未验证用户凭据或服务连通性。"
                "实际使用仍检查安装授权、凭据和应用服务响应。")
            wanted_mcp = [name for name in wanted_mcp if name not in owned]
    if wanted_mcp:
        from . import mcp_servers
        mcp_status = await mcp_servers.readiness(session, wanted_mcp)
        detail = (
            f"{len(mcp_status['available'])} 个 MCP 连接已启用"
            if mcp_status["ok"] else
            "尚未启用：" + "、".join(mcp_status["missing"])
        )
        dependency_checks.append({
            "key": "mcp", "label": "MCP 连接可用",
            "ok": bool(mcp_status["ok"]), "detail": detail,
            "detailMessage": descriptor("plugin.mcp.ready" if mcp_status["ok"] else "plugin.mcp.missing",
                detail, params={"count": len(mcp_status["available"]), "names": "、".join(mcp_status["missing"])}),
        })
        if not mcp_status["ok"]:
            blockers.append("插件需要但企业尚未启用的 MCP：" +
                            "、".join(mcp_status["missing"]))
        if binding_config is not None:
            try:
                tool_grants = plugin_runtime.normalize_mcp_tools(
                    dict(binding_config or {}).get("mcpTools"), wanted_mcp)
                missing_tools = [name for name in wanted_mcp if not tool_grants.get(name)]
            except ValueError as exc:
                tool_grants, missing_tools = {}, list(wanted_mcp)
                blockers.append(str(exc))
            detail = (f"已批准 {sum(len(x) for x in tool_grants.values())} 个具体工具"
                      if not missing_tools else
                      "尚未选择：" + "、".join(missing_tools))
            dependency_checks.append({
                "key": "mcp-tools", "label": "MCP 工具最小授权",
                "ok": not missing_tools, "detail": detail,
                "detailMessage": descriptor("plugin.tools.ready" if not missing_tools else "plugin.tools.missing",
                    detail, params={"count": sum(len(x) for x in tool_grants.values()), "names": "、".join(missing_tools)}),
            })
            if missing_tools:
                blockers.append("请为这些 MCP 只批准插件实际需要的工具：" +
                                "、".join(missing_tools))

    wanted_runtime = list(capability.get("runtime") or [])
    if wanted_runtime:
        from . import execution_capabilities, runner_hub
        candidate_reports = [
            dict(getattr(runner, "capabilities", None) or {})
            for runner in runner_hub.online()
        ]
        candidate_reports.append(execution_capabilities.runtime_report())
        ai_nodes = [node for node in nodes
                    if str(node.get("type") or "") in {"ai", "ai_review"}]
        requirements = [
            plugin_runtime.node_capabilities(node, capability)["runtime"]
            for node in ai_nodes
        ]
        requirements = [item for item in requirements if item]
        if not requirements:
            requirements = [wanted_runtime]
        missing_runtime: list[str] = []
        for required in requirements:
            if not any(execution_capabilities.evaluate(report, required).get("ok")
                       for report in candidate_reports):
                missing_runtime.extend(required)
        missing_runtime = list(dict.fromkeys(missing_runtime))
        runtime_ok = not missing_runtime
        runtime_labels = "、".join(execution_capabilities.label(x)
                                  for x in wanted_runtime)
        missing_labels = "、".join(execution_capabilities.label(x)
                                  for x in missing_runtime)
        dependency_checks.append({
            "key": "runtime", "label": "执行能力可用",
            "ok": bool(runtime_ok),
            "detail": (f"每个执行节点都能找到兼容执行机：{runtime_labels}" if runtime_ok
                       else f"当前没有兼容执行机承接：{missing_labels}"),
        })
        if not runtime_ok:
            blockers.append(
                f"当前没有在线 Runner 能承接插件需要的能力：{missing_labels}；"
                "请先在 Agent 管理中让符合条件的执行机上线")

    # Check that declared logical secrets map to available references in the current organization without reading values.
    wanted_secrets = set(str(x) for x in capability.get("secrets") or [])
    mapped = {str(k): str(v) for k, v in dict(secret_refs or {}).items() if v}
    for name in sorted(wanted_secrets - set(mapped)):
        blockers.append(f"插件需要密钥「{name}」，当前绑定还没有选择密钥引用")
    if wanted_secrets & set(mapped):
        refs = list((await session.execute(select(am.SecretReference).where(
            am.SecretReference.id.in_(set(mapped.values()))))).scalars().all())
        by_id = {row.id: row for row in refs}
        for name in sorted(wanted_secrets & set(mapped)):
            ref = by_id.get(mapped[name])
            if (ref is None or not ref.enabled or ref.provider != "runner-env"
                    or (ref.org_id is not None and ref.org_id != org_id)):
                blockers.append(f"插件密钥「{name}」映射的引用不存在、已停用或不属于当前组织")

    # Verify each declared deployment environment exists in organization or global scope.
    wanted = {str(dict(n.get("config") or {}).get("environmentKey") or "")
              for n in nodes if n.get("type") == "deploy"} - {""}
    if wanted:
        rows = list((await session.execute(select(am.Environment).where(
            am.Environment.key.in_(wanted),
            am.Environment.enabled.is_(True),
            (am.Environment.org_id == org_id) | (am.Environment.org_id.is_(None))
        ))).scalars().all())
        for key in sorted(wanted - {x.key for x in rows}):
            blockers.append(f"发布节点要的环境「{key}」不存在或已停用（去环境中心建它）")

    # Verify required repository capabilities against the project's configured repositories.
    needs_repo = repository_nodes(version.workflow or {})
    if needs_repo:
        repos = list((await session.execute(select(models.Repo).where(
            models.Repo.project_id == (project.id if project is not None else "__none__")
        ))).scalars().all()) if project is not None else []
        if project is None:
            warnings.append(
                "这些节点要代码仓库（%s）：组织级绑定下，需求必须自己挂到有仓库的项目"
                % "、".join(needs_repo[:5]))
        elif not repos:
            blockers.append("这些节点要代码仓库（%s），但项目「%s」下面一个工程都没有"
                            % ("、".join(needs_repo[:5]), project.name))
        else:
            # Reuse code_delivery's eligibility rules.
            # Duplicated rules can incorrectly demand a Hub-local merge directory.
            # Remote merge providers do not necessarily require a backend checkout.
            from . import code_delivery
            if not any(code_delivery._delivery_ready(r) for r in repos):
                blockers.append(
                    "这些节点要自动合并（%s），但项目「%s」的工程还没配服务端合并目录与"
                    "合并分支；历史 Gerrit 映射需先迁移到 GitLab 或通用 Git"
                    % ("、".join(needs_repo[:5]), project.name))

    # Require deployment targets when the declared release chain needs them.
    if any(n.get("type") in ("deploy", "deploy_chain") for n in nodes) and project is not None:
        repo_ids = set((await session.execute(select(models.Repo.id).where(
            models.Repo.project_id == project.id))).scalars().all())
        has_target = bool(repo_ids) and bool(await session.scalar(select(
            am.DeploymentTarget.id).where(
                am.DeploymentTarget.repo_id.in_(repo_ids),
                am.DeploymentTarget.enabled.is_(True)).limit(1)))
        if not has_target:
            warnings.append("这个插件有发布节点，但项目里还没有任何部署目标——"
                            "跑到发布那一步会停下来等你配（配好可点「重跑这一关」续走）")

    # Require a matching CICD publication route for CICD publish nodes.
    # Detect missing final-stage configuration before the workflow starts.
    # Do not defer a known publication blocker until after implementation and review.
    if project is not None:
        from . import cicd_workflow, release_providers
        cicd_nodes = [str(n.get("key")) for n in nodes
                      if n.get("type") == "publish" and cicd_workflow.wants_cicd(n)]
        if cicd_nodes:
            repo_ids = set((await session.execute(select(models.Repo.id).where(
                models.Repo.project_id == project.id))).scalars().all())
            rows = list((await session.execute(select(am.DeploymentTarget).where(
                am.DeploymentTarget.repo_id.in_(repo_ids or {"__none__"}),
                am.DeploymentTarget.enabled.is_(True)))).scalars().all())
            ready = [x for x in rows
                     if release_providers.provider_of(x) == release_providers.CICD
                     and not release_providers.validate(release_providers.CICD, x.config or {})]
            if not ready:
                blockers.append(
                    "「%s」这一关要走公司 CICD 发布，但项目「%s」还没配好这条发布通路"
                    "（环境中心 → 接入部署目标 → 选「公司 CICD」，填客户名即可）"
                    % ("、".join(cicd_nodes[:3]), project.name))
    return {"ok": not blockers, "blockers": blockers, "warnings": warnings,
            "checks": dependency_checks}


async def simulate(session: AsyncSession, version: am.PluginVersion, project,
                   org_id: str | None, agent_kind: str = "",
                   binding_config: dict | None = None,
                   secret_refs: dict | None = None) -> dict:
    """Dry-run a version against today's project and execution environment.

    No task, process, repository or environment is changed. The result is deliberately
    structured so the UI can explain exactly what is ready and what the administrator must fix.
    """
    readiness = await binding_readiness(
        session, version, project, org_id, secret_refs=secret_refs,
        binding_config=binding_config, application_context=True)
    blockers = list(readiness["blockers"])
    warnings = list(readiness["warnings"])
    checks = [{
        "key": "trust", "label": "版本已审批",
        "ok": version.trust_state == "approved" and bool(version.enabled),
        "detail": ("可以进入项目绑定" if version.trust_state == "approved" and version.enabled
                   else "版本仍在隔离区；完成能力审查后才能启用"),
    }]
    checks[-1]["detailMessage"] = descriptor(
        "plugin.trust.ready" if checks[-1]["ok"] else "plugin.trust.pending", checks[-1]["detail"])
    if not checks[-1]["ok"]:
        blockers.append(checks[-1]["detail"])
    checks.extend(list(readiness.get("checks") or []))

    try:
        from . import workflow_inputs
        resolved = await workflow_inputs.plugin_skills(session, version)
        bundled_count = sum(1 for x in resolved if x.get("bundled"))
        checks.append({
            "key": "skills", "label": "技能可用", "ok": True,
            "detail": f"{len(resolved)} 项技能已就绪，其中 {bundled_count} 项随插件锁定",
            "detailMessage": descriptor("plugin.skills.ready", params={"count": len(resolved), "bundled": bundled_count}),
        })
    except ValueError as exc:
        checks.append({"key": "skills", "label": "技能可用", "ok": False,
                       "detail": str(exc)})
        blockers.append(str(exc))

    nodes = list(dict(version.workflow or {}).get("nodes") or [])[:100]
    route_state = await plugin_route_readiness.check(
        session, version, binding_config=binding_config, agent_kind=agent_kind)
    blockers.extend(route_state["blockers"])
    warnings.extend(route_state["warnings"])
    checks.append(route_state["check"])
    routes = route_state["routes"]
    first_agent = route_state["agent"]
    project_ok = not readiness["blockers"]
    checks.append({
        "key": "project", "label": "项目与环境配置", "ok": project_ok,
        "detail": ("当前项目满足这条流程" if project_ok else "请先处理下面的阻断项"),
        "detailMessage": descriptor("plugin.project.ready" if project_ok else "plugin.project.pending"),
    })
    for row in checks:
        row["labelMessage"] = descriptor("plugin.check." + row["key"], row["label"])
    route_by_node = {row["nodeKey"]: row["requested"] for row in routes}
    return {
        "dryRun": True, "ok": not blockers, "checks": checks,
        "blockers": list(dict.fromkeys(blockers)),
        "warnings": list(dict.fromkeys(warnings)),
        "agent": first_agent, "agentRoutes": routes,
        "project": ({"id": project.id, "name": project.name} if project else None),
        "plan": [{"key": str(x.get("key") or ""), "name": str(x.get("name") or ""),
                  "type": str(x.get("type") or ""),
                  "dependsOn": list(x.get("dependsOn") or []),
                  "execution": route_by_node.get(str(x.get("key") or ""), {})}
                 for x in nodes],
    }
