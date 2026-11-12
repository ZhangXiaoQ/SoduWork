"""Unified execution options for new drafts and existing requirements. Resolve authorized
repositories, workflows, and executors together; scenarios recommend methods without restricting
an existing task's executor to that recommendation.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from ..agent_catalog import AGENTS
from . import (agent_execution_options, agent_naming, ai_exec, conversation_handoffs,
               execution_capabilities, inbox, model_catalog, plugin_installations,
               plugin_service, task_access, task_assignment, work_catalog)

_CLI_ORDER = {key: row.get("order", 999) for key, row in AGENTS.items()}
_CLI_LABELS = {key: row["displayName"] for key, row in AGENTS.items()}


async def _visible_repos(
    session: AsyncSession, client: models.Client
) -> tuple[models.User | None, list[dict]]:
    me, scope = await inbox._me_scope(session, client)
    query = select(models.Project).where(models.Project.status == "active")
    query = query.where(or_(
        models.Project.org_id.in_(scope), models.Project.org_id.is_(None)
    )) if scope else query.where(models.Project.org_id.is_(None))
    projects = {
        row.id: row for row in
        (await session.execute(query)).scalars().all()
    }
    if not projects:
        return me, []
    rows = list((await session.execute(select(models.Repo).where(
        models.Repo.project_id.in_(list(projects))
    ).order_by(models.Repo.created_at))).scalars().all())
    return me, [{
        "id": row.id,
        "projectId": row.project_id,
        "projectName": projects[row.project_id].name,
        "name": row.name,
        "kind": row.kind,
        "gitUrl": row.git_url,
        "branch": row.default_branch,
        "localDir": row.local_dir,
        "note": row.note,
    } for row in rows]


async def installed_workflows(
    session: AsyncSession, client: models.Client, items: list[dict]
) -> list[dict]:
    """Narrow authorized bindings to built-ins or this user's enabled installations.

    Installation is only a picker preference: binding/version permissions and
    execution readiness remain authoritative in available_bindings and dispatch.
    Never infer a built-in from an organization-wide or project-default binding.
    """
    installations = await plugin_installations.by_plugin(
        session, str(getattr(client, "user_ref", "") or ""),
        [item.get("pluginId") for item in items or []])
    selected = []
    for item in items or []:
        builtin = item.get("sourceKind") == "builtin"
        installation = installations.get(str(item.get("pluginId") or ""))
        installed = bool(installation and installation.enabled)
        if builtin or installed:
            selected.append({**item, "builtin": builtin, "installed": installed,
                             "selectionSource": "builtin" if builtin else "installed"})
    return selected


def select_workflows(items: list[dict], project_id: str, default_key: str, *,
                     for_execution: bool = False) -> list[dict]:
    """Retain all authorized execution candidates; scenario and project defaults only affect
    ranking.
    """
    selected = [
        dict(item) for item in items or []
        if for_execution or (project_id and item.get("projectSpecific"))
        or (default_key and item.get("key") == default_key)
    ]
    selected.sort(key=lambda item: (
        not bool(item.get("runnable", True)),
        not bool(item.get("isDefault")),
        item.get("key") != default_key,
        not bool(item.get("projectSpecific")),
        str(item.get("name") or "").lower(),
    ))
    for item in selected:
        item["recommended"] = bool(
            item.get("runnable", True) and
            (item.get("isDefault") or item.get("key") == default_key))
    return selected


def partition_workflows(items: list[dict]) -> tuple[list[dict], list[dict]]:
    """Keep the selectable contract safe by default while preserving diagnostics."""
    runnable, blocked = [], []
    for item in items or []:
        (runnable if item.get("runnable", True) else blocked).append(item)
    return runnable, blocked


def substrate_options(agents: list[dict], required: list[str], current_client_id: str = "") -> list[dict]:
    """Aggregate machine seats into portable CLI types, resolving the actual Runner at dispatch."""
    needed = set(execution_capabilities.normalize(required))
    grouped: dict[str, dict] = {}
    seen_seats: set[str] = set()
    for agent in agents or []:
        if agent.get("online") is False or agent.get("off") is True:
            continue
        cli = agent_naming.cli_key(
            str(agent.get("cli") or agent.get("cliName") or ""))
        if not cli:
            continue
        seat = agent_naming.desk_key(
            machine=str(agent.get("machineKey") or ""), cli=cli,
            name=str(agent.get("name") or ""),
            runner_id=str(agent.get("runnerId") or ""),
            host=str(agent.get("host") or ""))
        if seat in seen_seats:
            continue
        seen_seats.add(seat)
        group = grouped.setdefault(cli, {
            "key": "local:" + cli,
            "cli": cli,
            "name": _CLI_LABELS.get(cli, str(agent.get("cliName") or cli)),
            "onlineSeats": 0,
            "busySeats": 0,
            "runnerLoad": 0,
            "machines": [],
            "_locations": [],
            "versions": [],
            "modelPick": False,
            "_compatible": False,
            "_capabilitySets": [],
        })
        group["onlineSeats"] += 1
        group["busySeats"] += int(bool(agent.get("busy")))
        group["runnerLoad"] = max(
            int(group.get("runnerLoad") or 0),
            max(0, int(agent.get("runnerBusy") or 0)),
        )
        kind = "local:" + cli
        # This endpoint's model list contains shared model service models only. Native
        # account models have a separate catalog and must not use that dropdown.
        group["modelPick"] = kind in agent_execution_options.GATEWAY_MODEL_KINDS
        group["nativeModelPick"] = agent_execution_options.is_native_model_kind(kind)
        group["modelSource"] = ("gateway" if group["modelPick"] else
                                "native" if group["nativeModelPick"] else "agent")
        machine = str(agent.get("machineLabel") or agent.get("host") or "").strip()
        if machine and machine not in group["machines"]:
            group["machines"].append(machine)
        version = str(agent.get("cliVersion") or "").strip()
        if version and version not in group["versions"]:
            group["versions"].append(version)
        client_id = str(agent.get("clientId") or "")
        # A WebSocket-connected Runner may be on this very device. Transport
        # metadata is not execution location; compare authenticated device ids.
        remote = (client_id != current_client_id if client_id and current_client_id
                  else bool(agent.get("remote") or agent.get("runnerId") or client_id))
        route_label = (("远程 Runner" if remote else "本机") +
                       ((" · " + machine) if machine else ""))
        location = {
            "id": str(agent.get("id") or ("runner:" + str(agent.get("runnerId") or "") + ":" + cli)),
            "assigneeId": str(agent.get("id") or ""),
            "mode": "remote" if remote else "local",
            "label": route_label,
            "machineKey": str(agent.get("machineKey") or ""),
            "runnerId": str(agent.get("runnerId") or ""),
            "clientId": str(agent.get("clientId") or ""),
            "runnerKind": str(agent.get("runnerKind") or
                               ("work-computer" if agent.get("clientId") else "cloud")),
            "host": str(agent.get("host") or ""),
            "busy": bool(agent.get("busy")),
            "version": version,
        }
        if not any(item["mode"] == location["mode"] and
                   item["machineKey"] == location["machineKey"] and
                   item["runnerId"] == location["runnerId"]
                   for item in group["_locations"]):
            group["_locations"].append(location)
        group.setdefault("_assigneeIds", []).append(location["assigneeId"])
        report = execution_capabilities.clean_report(agent.get("capabilities"))
        available = set(report.get("available") or [])
        group["_capabilitySets"].append(sorted(available))
        if not needed or needed.issubset(available):
            group["_compatible"] = True

    result = []
    for cli, group in grouped.items():
        compatible = bool(group.pop("_compatible"))
        group["capabilitySets"] = group.pop("_capabilitySets")
        locations = group.pop("_locations")
        group["locations"] = locations
        group["assigneeIds"] = [item for item in group.pop("_assigneeIds", []) if item]
        group["defaultAssigneeId"] = next(
            (item["assigneeId"] for item in locations if item.get("assigneeId")), "")
        modes = {item["mode"] for item in locations}
        group["locationMode"] = "mixed" if len(modes) > 1 else (
            next(iter(modes)) if modes else "local")
        group["locationLabel"] = ("本机 + 远程 Runner" if len(modes) > 1 else
                                   (locations[0]["label"] if locations else "本机"))
        group["available"] = bool(compatible and group["onlineSeats"])
        if not compatible:
            note = "当前设备上的在线 Runner 尚未具备这项工作需要的全部能力"
        elif group["busySeats"] >= group["onlineSeats"]:
            note = "当前设备上的席位正在忙；SoduWork 会排队并防止重复派发"
        elif group["runnerLoad"]:
            note = "当前设备另有 %s 项工作在执行；仍可继续派发并独立运行" % group["runnerLoad"]
        else:
            note = "SoduWork 将在当前设备上按能力与负载选择可用席位"
        group["note"] = note
        group["status"] = "ready" if group["available"] else "blocked"
        group["requiredCapabilities"] = sorted(needed)
        result.append(group)
    result.sort(key=lambda item: (
        not item["available"], _CLI_ORDER.get(item["cli"], 999), item["name"].lower()))
    return result


def _recommended_flow(workflows: list[dict], default_key: str) -> dict | None:
    runnable = [item for item in workflows if item.get("runnable", True)]
    return next((item for item in runnable if item.get("isDefault")), None) or next(
        (item for item in runnable if item.get("key") == default_key), None)


def recommended_strategy(flow: dict | None, substrate: dict | None,
                         workflow_required: bool, default_key: str) -> str:
    """Managed repository work must never fall back to an invalid direct run."""
    if workflow_required:
        return "workflow" if flow else "blocked"
    if flow and default_key != "ai-errand":
        return "workflow"
    if substrate:
        return "direct"
    if flow:
        return "workflow"
    return "manual"


def _workflow_blocker(workflows: list[dict]) -> str:
    for item in workflows or []:
        readiness = dict(item.get("readiness") or {})
        blockers = list(readiness.get("blockers") or [])
        if blockers:
            return str(blockers[0])
    return ""


def _routing_for_task(task, recommendation: dict) -> dict:
    """Existing tasks execute against their creation-time capability contract."""
    frozen = dict(getattr(task, "work_routing", None) or {}) if task is not None else {}
    if not frozen:
        return work_catalog.routing_snapshot(recommendation)
    if getattr(task, "work_scenario_key", ""):
        frozen.setdefault("scenarioKey", str(task.work_scenario_key))
    if getattr(task, "work_scenario_name", ""):
        frozen.setdefault("scenarioName", str(task.work_scenario_name))
    return frozen


async def build(
    session: AsyncSession, client: models.Client, body: dict
) -> dict:
    request = dict(body or {})
    task = None
    task_id = str(request.get("taskId") or "").strip()
    if task_id:
        task = await task_access.view_task(session, client, task_id)
        if not task_access.is_owner(task, client):
            raise ValueError("只有当前承办设备可以安排这项需求")
        request.update({
            "title": task.title or "",
            "note": task.note or "",
            "tags": list(task.tags or []),
            "projectId": str(task.project_id or ""),
            "scenarioKey": str(task.work_scenario_key or ""),
        })
        request["repoId"] = str(request.get("repoId") or task.repo_id or "")

    me, repos = await _visible_repos(session, client)
    locked_project = str(task.project_id or "") if task is not None else ""
    if locked_project:
        repos = [item for item in repos if item["projectId"] == locked_project]
    by_repo = {item["id"]: item for item in repos}
    repo_id = str(request.get("repoId") or "").strip()
    selected_repo = by_repo.get(repo_id)
    stale_selection = bool(repo_id and selected_repo is None)
    project_id = str(locked_project or
        (selected_repo or {}).get("projectId") or request.get("projectId") or "").strip()
    visible_projects = {item["projectId"] for item in repos}
    if not locked_project and project_id not in visible_projects:
        project_id = ""

    text = "\\n".join([
        str(request.get("title") or ""),
        str(request.get("note") or ""),
        " ".join(str(item) for item in (request.get("tags") or [])),
    ])
    recommendation = await work_catalog.recommend(
        session, text, me.org_id if me else None,
        list(me.positions or []) if me else [],
        explicit_key=str(request.get("scenarioKey") or ""),
        project_id=project_id)
    routing = _routing_for_task(task, recommendation)
    default_key = str(routing.get("defaultPluginKey") or "")

    # Preview plugins using the executor's currently selected visible repository.
    # Build read-only context here; confirmed dispatch persists real associations.
    stand_in = SimpleNamespace(
        id=task_id, project_id=(project_id or None), owner_client_id=client.id,
        repo_id=(selected_repo or {}).get("id") or None,
        work_routing=dict(getattr(task, "work_routing", None) or {}))
    selected_execution = dict(request.get("execution") or {})
    # Creation-time recommendations are not method allowlists for later execution.
    # available_bindings remains responsible for permissions, versions, project scope, and runtime conditions.
    for_execution = task is not None
    all_workflows = await plugin_service.available_bindings(
        session, stand_in,
        global_keys=(None if for_execution else ({default_key} if default_key else set())),
        run_context=({"execution": selected_execution}
                     if selected_execution else None))
    all_workflows = await installed_workflows(session, client, all_workflows)
    workflows = select_workflows(all_workflows, project_id, default_key,
                                 for_execution=for_execution)
    runnable_workflows, blocked_workflows = partition_workflows(workflows)

    # Read current model and Runner configuration for dispatch options.
    # Stale process caches would hide newly configured executors during creation or retry.
    ctx = ai_exec.with_client_runner_scope(await ai_exec.load(session, force=True), client.id)
    roster = await asyncio.to_thread(ai_exec.list_assignees_sync, ctx)
    # The normal employee scope intentionally exposes only the current
    # device.  For a task created on mobile/Web, add the same-account remote
    # targets authorized by the handoff directory.  This is a display-only
    # merge; dispatch still revalidates the concrete assignee and runner at the
    # final boundary, so a stale target cannot silently fall back locally.
    remote_targets = []
    try:
        remote_targets = await conversation_handoffs.targets(session, client)
    except Exception:
        # A transient directory problem must not hide healthy local choices.
        remote_targets = []
    remote_agents = []
    for target in remote_targets:
        agent_id = str(target.get("agentId") or "").strip()
        runner_id = str(target.get("runnerId") or "").strip()
        if not agent_id or not runner_id:
            continue
        remote_agents.append({
            "id": str(target.get("id") or ("runner:" + runner_id + ":" + agent_id)),
            "type": "agent", "cli": agent_id,
            "cliName": target.get("cliName") or agent_id,
            "name": target.get("name") or target.get("runnerName") or runner_id,
            "online": True, "remote": True, "local": False,
            "runnerId": runner_id, "clientId": target.get("clientId") or "",
            "runnerKind": target.get("runnerKind") or "cloud",
            "runnerName": target.get("runnerName") or target.get("machineLabel") or runner_id,
            "machineLabel": target.get("machineLabel") or target.get("runnerName") or runner_id,
            "machineKey": target.get("machineKey") or runner_id,
            "host": target.get("host") or "",
            "modelMode": target.get("modelMode") or "managed",
            "modelPick": "local:" + agent_id in agent_execution_options.GATEWAY_MODEL_KINDS,
            "capabilities": target.get("capabilities") or {},
            "note": "在 %s 上执行，目标不可用时不会自动改派本机" % (
                target.get("runnerName") or target.get("host") or runner_id),
        })
    current_ids = {str(item.get("id") or "") for item in roster.get("agents") or []}
    merged_agents = list(roster.get("agents") or []) + [
        item for item in remote_agents if item["id"] not in current_ids]
    legacy_models = ai_exec.model_choices(ctx)
    model_choices = await model_catalog.choices(
        session, client, str(legacy_models.get("default") or ""))
    from .model_defaults import public_defaults
    defaults = public_defaults(model_choices.get("items") or [], client)
    required = list(routing.get("requiredAgentCapabilities") or [])
    substrates = substrate_options(merged_agents, required, client.id)

    flow = _recommended_flow(runnable_workflows, default_key)
    project_defaults = await task_assignment.project_route(session, project_id)
    preferred_kind = str(
        project_defaults.get("agentKind") or (flow or {}).get("agentKind") or "")
    preferred_cli = agent_naming.cli_key(preferred_kind.split(":", 1)[-1])
    default_id = str((ai_exec.default_assignee(ctx) or {}).get("id") or "")
    default_cli = preferred_cli or agent_naming.cli_key(default_id.split(":", 1)[-1])
    available_substrates = [item for item in substrates if item["available"]]
    substrate = next(
        (item for item in available_substrates if item["cli"] == default_cli),
        available_substrates[0] if available_substrates else None)
    # Project context recommends workflows; it does not prohibit direct AI work.
    # Actual dispatch still validates ownership, Runner readiness and capabilities.
    # Preserve this field for clients using the previous response contract.
    workflow_required = False
    strategy = recommended_strategy(
        flow, substrate, workflow_required, default_key)
    blocked_reason = (
        _workflow_blocker(blocked_workflows)
        if workflow_required and not flow else "")

    return {
        "schemaVersion": 2,
        "availability": {
            "agentReason": str(roster.get("reason") or ""),
            "remoteTargetCount": len(remote_agents),
        },
        "repos": repos,
        "selection": {
            "taskId": task_id,
            "repoId": repo_id if selected_repo else "",
            "projectId": project_id,
            "stale": stale_selection,
            "projectLocked": bool(locked_project),
        },
        "task": ({
            "id": task.id, "title": task.title,
            "projectId": str(task.project_id or ""),
            "repoId": str(task.repo_id or ""),
        } if task is not None else None),
        "scenario": {
            "key": routing.get("scenarioKey") or "",
            "name": routing.get("scenarioName") or "",
            "reason": routing.get("reason") or "",
            "routing": routing,
        },
        # Selectors consume only runnable rows. Blocked rows remain available for
        # an explanatory empty state, but cannot accidentally become a choice.
        "workflows": runnable_workflows,
        "blockedWorkflows": blocked_workflows,
        "substrates": substrates,
        "executionTargets": [{key: target.get(key) for key in (
            "id", "agentId", "cliName", "name", "runnerId", "runnerKind",
            "runnerName", "machineLabel", "host", "clientId", "modelMode")}
            for target in remote_targets],
        "models": list(model_choices.get("list") or []),
        "modelOptions": list(model_choices.get("items") or []),
        "defaultModel": str(model_choices.get("default") or ""),
        "defaultModels": defaults["defaultModels"],
        "defaultModelErrors": defaults["defaultModelErrors"],
        "recommendation": {
            "strategy": strategy,
            "workflowRequired": workflow_required,
            "blockedReason": blocked_reason,
            "workflowBindingId": str((flow or {}).get("bindingId") or ""),
            "substrateKey": str((substrate or {}).get("key") or ""),
            "agentKind": preferred_kind,
        },
    }
