# -*- coding: utf-8 -*-
"""Management writes are deny-by-default and department-tree mutations stay scoped."""
from __future__ import annotations

import asyncio
import inspect
import json
import os
from pathlib import Path
import tempfile


_tmp = tempfile.TemporaryDirectory(prefix="soduwork-smoke-admin-security-")
os.environ["DATABASE_URL"] = (
    "sqlite+aiosqlite:///" + (Path(_tmp.name) / "security.db").as_posix())

import httpx  # noqa: E402
from sqlalchemy import func, select  # noqa: E402
from route_test_support import api_routes  # noqa: E402

from app import models  # noqa: E402
from app.auth import sign_token  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.deps import current_user  # noqa: E402
from app.main import app  # noqa: E402


passed = failed = 0
MUTATIONS = {"POST", "PUT", "PATCH", "DELETE"}
AUDIT_EXEMPT = {
    ("POST", "/api/v1/admin/login"): "authentication entry",
    ("POST", "/api/v1/admin/me/inbox/{tid}/claim"): "authenticated self-service claim",
    ("POST", "/api/v1/admin/alert-config/test"): "non-persistent probe",
    ("POST", "/api/v1/admin/capabilities/mcp/preflight"): "preflight only",
    ("POST", "/api/v1/admin/capabilities/skills/preflight"): "preflight only",
    ("POST", "/api/v1/admin/deployment-targets/{target_id}/probe"): "non-persistent probe",
    ("POST", "/api/v1/admin/dev-flow/preview"): "preview only",
    ("POST", "/api/v1/admin/environment-preflight"): "preflight only",
    ("POST", "/api/v1/admin/integrations/{integration_id}/pull-account/test"): "non-persistent probe",
    ("POST", "/api/v1/admin/mcp-servers/probe"): "non-persistent probe",
    ("POST", "/api/v1/admin/plugins/preflight"): "preflight only",
    ("POST", "/api/v1/admin/plugins/versions/{version_id}/simulate"): "simulation only",
    ("POST", "/api/v1/admin/runners/{runner_id}/probe"): "non-persistent probe",
    ("POST", "/api/v1/admin/secret-references/{ref_id}/probe"): "non-persistent probe",
}


def check(name: str, condition: bool, detail="") -> None:
    global passed, failed
    if condition:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + ("  << " + str(detail)[:500] if detail else ""))


def dependency_calls(dependant):
    for child in dependant.dependencies:
        yield child.call
        yield from dependency_calls(child)


def permission_contract() -> None:
    routes = []
    missing = []
    for route in api_routes(app):
        methods = set(route.methods or ()) & MUTATIONS
        if not methods or not route.path.startswith("/api/v1/admin"):
            continue
        routes.append(route)
        calls = list(dependency_calls(route.dependant))
        permissions = {
            permission
            for call in calls
            for permission in getattr(call, "__soduwork_permissions__", ())
        }
        if route.path == "/api/v1/admin/login":
            continue
        if route.path == "/api/v1/admin/me/inbox/{tid}/claim":
            if current_user not in calls:
                missing.append((route.path, sorted(methods), "current_user"))
            continue
        if not permissions:
            missing.append((route.path, sorted(methods), "permission"))
    check("management mutation inventory is not vacuous", len(routes) >= 139, len(routes))
    check("every management mutation has an explicit authorization contract",
          not missing, missing)


def audit_contract() -> None:
    missing = []
    seen_exemptions = set()
    mutation_count = 0
    for route in api_routes(app):
        methods = set(route.methods or ()) & MUTATIONS
        if not methods or not route.path.startswith("/api/v1/admin"):
            continue
        mutation_count += len(methods)
        source = inspect.getsource(route.endpoint)
        if (route.path == "/api/v1/admin/tasks/{tid}/ai-dispatch"
                and "from ..services.task_dispatch import dispatch" in source
                and "return await dispatch(tid, {}, owner, session, actor=user)" in source):
            # Shared dispatch owns the committed audit; the real HTTP actor
            # attribution is covered by test_admin_requirement_dispatch.py.
            from app.services import task_dispatch
            source += inspect.getsource(task_dispatch.dispatch)
        # Cloud-host state and its AuditLog commit together in the service,
        # rather than through the route-level audit.log helper. Follow these
        # exact delegates; they are persistent writes, never audit exemptions.
        cloud_audit = False
        if route.endpoint.__module__ == "app.api.admin_cloud_runners":
            from app.services import cloud_runner_admin
            delegate = {"availability": "availability", "reassign": "transfer",
                        "provision": "provision"}.get(route.endpoint.__name__)
            if delegate and f"return await service.{delegate}(session, user," in source:
                body = inspect.getsource(getattr(cloud_runner_admin, delegate))
                writer = inspect.getsource(cloud_runner_admin._audit)
                audit_at = body.find("\n    _audit(session, actor, row,")
                commit_at = body.rfind("await session.commit()")
                cloud_audit = (0 <= audit_at < commit_at
                    and "session.add(AuditLog(" in writer
                    and "actor_id=actor.id" in writer
                    and "action=action" in writer and "target_id=row.id" in writer)
        quota_audit = False
        if route.endpoint.__module__ == "app.api.quotas":
            from app.api import quotas
            writer = inspect.getsource(quotas.record)
            audit_at = source.find("\n    record(session, user,")
            commit_at = source.rfind("await session.commit()")
            quota_audit = (0 <= audit_at < commit_at
                           and "session.add(AuditLog(" in writer
                           and "actor_id=actor.id" in writer
                           and 'detail={"before": before, "after": after}' in writer)
        legal_audit = False
        if route.endpoint.__module__ == "app.api.legal_documents":
            from app.services import legal_publications
            delegate = route.endpoint.__name__
            body = source if delegate == "draft" else inspect.getsource(getattr(legal_publications, delegate))
            writer = inspect.getsource(legal_publications.audit_event)
            call = "legal.audit_event(" if delegate == "draft" else "audit_event("
            service_at = source.find("await legal." + ("save_draft" if delegate == "draft" else delegate) + "(")
            commit_at = source.rfind("await session.commit()")
            legal_audit = (0 <= service_at < commit_at and call in body
                           and "session.add(AuditLog(" in writer and "actor_id=actor.id" in writer
                           and "action=action" in writer and "target_id=target" in writer)
        if "audit.log(" in source or cloud_audit or quota_audit or legal_audit:
            continue
        for method in methods:
            key = (method, route.path)
            if key in AUDIT_EXEMPT:
                seen_exemptions.add(key)
            else:
                missing.append(key)
    check("audit inventory covers the complete management mutation graph",
          mutation_count >= 139, mutation_count)
    check("every persistent management mutation records an audit event",
          not missing, missing)
    stale = set(AUDIT_EXEMPT) - seen_exemptions
    check("audit exceptions are explicit, present, and still non-persistent",
          not stale, sorted(stale))


async def main() -> None:
    permission_contract()
    audit_contract()
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with SessionLocal() as session:
        org_a = models.OrgUnit(id="org-security-a", name="研发中心")
        org_a_child = models.OrgUnit(
            id="org-security-a-child", name="开发组", parent_id=org_a.id)
        org_b = models.OrgUnit(id="org-security-b", name="外地事业部")
        manager_role = models.Role(
            id="role-security-org-manager", name="部门组织管理员",
            permissions=["org.manage", "binding.manage",
                         "integration.manage"])
        manager = models.User(
            id="user-security-manager", username="security-manager",
            display_name="研发组织管理员", org_id=org_a.id,
            role_id=manager_role.id, is_active=True, auth_version=1)
        ordinary = models.User(
            id="user-security-ordinary", username="security-ordinary",
            display_name="普通员工", org_id=org_a_child.id,
            is_active=True, auth_version=1)
        outsider = models.User(
            id="user-security-outsider", username="security-outsider",
            display_name="外地员工", org_id=org_b.id,
            is_active=True, auth_version=1)
        super_user = models.User(
            id="user-security-super", username="security-super",
            display_name="超级管理员", is_super=True,
            is_active=True, auth_version=1)
        client_a = models.Client(
            id="client-security-a", name="研发 SoduWork", user_ref=ordinary.id,
            auth_state="active")
        client_b = models.Client(
            id="client-security-b", name="外地 SoduWork", user_ref=outsider.id,
            auth_state="active")
        integration = models.Integration(
            id="integration-security", name="安全测试源", type="generic", enabled=True)
        sibling_binding = models.IntegrationBinding(
            id="binding-security-sibling", integration_id=integration.id,
            external_actor="outside-actor", client_id=client_b.id)
        assignable = models.Task(
            id="task-security-assignable", title="待安全分配任务", origin="generic",
            integration_id=integration.id, external_actor="inside-actor")
        sibling_pool = models.Task(
            id="task-security-sibling-pool", title="外地团队任务", origin="generic",
            pool_org_id=org_b.id)
        session.add_all([
            org_a, org_a_child, org_b, manager_role, manager, ordinary, outsider,
            super_user, client_a, client_b, integration, sibling_binding,
            assignable, sibling_pool,
        ])
        await session.commit()

    manager_headers = {
        "Authorization": "Bearer " + sign_token("user-security-manager", 1)}
    ordinary_headers = {
        "Authorization": "Bearer " + sign_token("user-security-ordinary", 1)}
    super_headers = {
        "Authorization": "Bearer " + sign_token("user-security-super", 1)}
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://soduwork.test"
    ) as client:
        denied = await client.post(
            "/api/v1/admin/orgs", headers=ordinary_headers,
            json={"name": "越权新部门", "parentId": "org-security-a"})
        check("a user without org.manage cannot write the tree",
              denied.status_code == 403, denied.text)

        created = await client.post(
            "/api/v1/admin/orgs", headers=manager_headers,
            json={"name": "平台组", "parentId": "org-security-a", "sort": 3})
        created_body = created.json() if created.status_code == 200 else {}
        leaf_id = str(created_body.get("id") or "")
        check("department manager can create below the managed subtree",
              created.status_code == 200 and leaf_id, created.text)

        cross_create = await client.post(
            "/api/v1/admin/orgs", headers=manager_headers,
            json={"name": "越权部门", "parentId": "org-security-b"})
        check("department manager cannot create under a sibling tree",
              cross_create.status_code == 403, cross_create.text)

        root_create = await client.post(
            "/api/v1/admin/orgs", headers=manager_headers,
            json={"name": "伪造根部门", "parentId": ""})
        check("only a super administrator may create a root department",
              root_create.status_code == 403, root_create.text)

        cross_update = await client.patch(
            "/api/v1/admin/orgs/org-security-b", headers=manager_headers,
            json={"name": "被越权改名"})
        check("department manager cannot modify a sibling tree",
              cross_update.status_code == 403, cross_update.text)

        cycle = await client.patch(
            "/api/v1/admin/orgs/org-security-a", headers=manager_headers,
            json={"parentId": leaf_id})
        check("department tree rejects parent-child cycles",
              cycle.status_code == 400 and "下级" in cycle.text, cycle.text)

        promote = await client.patch(
            f"/api/v1/admin/orgs/{leaf_id}", headers=manager_headers,
            json={"parentId": ""})
        check("department manager cannot promote a node outside the subtree",
              promote.status_code == 403, promote.text)

        renamed = await client.patch(
            f"/api/v1/admin/orgs/{leaf_id}", headers=manager_headers,
            json={"name": "平台工程组", "sort": 4})
        check("authorized in-scope update still works",
              renamed.status_code == 200
              and renamed.json().get("name") == "平台工程组", renamed.text)

        removed = await client.delete(
            f"/api/v1/admin/orgs/{leaf_id}", headers=manager_headers)
        check("authorized in-scope leaf deletion still works",
              removed.status_code == 200 and removed.json().get("ok") is True,
              removed.text)

        cross_delete = await client.delete(
            "/api/v1/admin/orgs/org-security-b", headers=manager_headers)
        check("department manager cannot delete a sibling tree",
              cross_delete.status_code == 403, cross_delete.text)

        super_root = await client.post(
            "/api/v1/admin/orgs", headers=super_headers,
            json={"name": "新企业根", "parentId": ""})
        check("super administrator retains root governance",
              super_root.status_code == 200
              and super_root.json().get("parentId") is None, super_root.text)

        created_integration = await client.post(
            "/api/v1/admin/integrations", headers=manager_headers,
            json={"name": "一次性令牌源", "type": "generic", "config": {}})
        created_integration_body = (
            created_integration.json() if created_integration.status_code == 200 else {})
        created_integration_id = str(created_integration_body.get("id") or "")
        first_token = str(created_integration_body.get("ingestToken") or "")
        check("integration token is revealed once at creation",
              created_integration.status_code == 200 and created_integration_id
              and first_token.startswith("ingest_")
              and created_integration_body.get("ingestTokenSet") is True,
              created_integration.text)

        listed_integrations = await client.get(
            "/api/v1/admin/integrations", headers=manager_headers)
        listed_row = next((row for row in listed_integrations.json()
                           if row.get("id") == created_integration_id), {})
        check("integration lists report credential presence without plaintext",
              listed_integrations.status_code == 200
              and listed_row.get("ingestTokenSet") is True
              and "ingestToken" not in listed_row
              and first_token not in listed_integrations.text, listed_row)

        updated_integration = await client.patch(
            f"/api/v1/admin/integrations/{created_integration_id}",
            headers=manager_headers, json={"config": {"mcpKey": "mcp-private-value"}})
        updated_body = updated_integration.json() if updated_integration.status_code == 200 else {}
        check("integration updates mask config secrets and never echo the ingest token",
              updated_integration.status_code == 200
              and updated_body.get("config", {}).get("mcpKey") == "***"
              and "ingestToken" not in updated_body, updated_integration.text)

        rotated = await client.post(
            f"/api/v1/admin/integrations/{created_integration_id}/token/rotate",
            headers=manager_headers, json={})
        rotated_body = rotated.json() if rotated.status_code == 200 else {}
        rotated_token = str(rotated_body.get("ingestToken") or "")
        listed_after_rotate = await client.get(
            "/api/v1/admin/integrations", headers=manager_headers)
        check("token rotation invalidates the old secret and reveals the replacement once",
              rotated.status_code == 200 and rotated_token.startswith("ingest_")
              and rotated_token != first_token and first_token not in listed_after_rotate.text
              and rotated_token not in listed_after_rotate.text, rotated.text)

        own_binding = await client.post(
            "/api/v1/admin/bindings", headers=manager_headers,
            json={"integration_id": "integration-security",
                  "external_actor": "inside-actor",
                  "client_id": "client-security-a"})
        own_binding_body = own_binding.json() if own_binding.status_code == 200 else {}
        own_binding_id = str(own_binding_body.get("id") or "")
        check("department manager can bind an external actor to an in-scope SoduWork",
              own_binding.status_code == 200 and own_binding_id, own_binding.text)

        cross_binding = await client.post(
            "/api/v1/admin/bindings", headers=manager_headers,
            json={"integration_id": "integration-security",
                  "external_actor": "cross-created",
                  "client_id": "client-security-b"})
        check("department manager cannot bind an actor to a sibling SoduWork",
              cross_binding.status_code == 403, cross_binding.text)

        cross_binding_delete = await client.delete(
            "/api/v1/admin/bindings/binding-security-sibling",
            headers=manager_headers)
        check("department manager cannot delete a sibling SoduWork binding",
              cross_binding_delete.status_code == 403, cross_binding_delete.text)

        cross_assign = await client.post(
            "/api/v1/admin/unassigned/task-security-assignable/assign",
            headers=manager_headers,
            json={"client_id": "client-security-b", "create_binding": False})
        check("department manager cannot assign work to a sibling SoduWork",
              cross_assign.status_code == 403, cross_assign.text)

        cross_pool = await client.post(
            "/api/v1/admin/unassigned/task-security-sibling-pool/assign",
            headers=manager_headers,
            json={"client_id": "client-security-a", "create_binding": False})
        check("department manager cannot take a sibling department inbox task",
              cross_pool.status_code == 403, cross_pool.text)

        visible_bindings = await client.get(
            "/api/v1/admin/bindings", headers=manager_headers)
        binding_ids = {row.get("id") for row in visible_bindings.json()}
        check("binding list filters sibling departments instead of failing the page",
              visible_bindings.status_code == 200 and own_binding_id in binding_ids
              and "binding-security-sibling" not in binding_ids, binding_ids)

        visible_unassigned = await client.get(
            "/api/v1/admin/unassigned", headers=manager_headers)
        unassigned_ids = {row.get("id") for row in visible_unassigned.json()}
        check("unassigned list hides sibling department inbox tasks",
              visible_unassigned.status_code == 200
              and "task-security-assignable" in unassigned_ids
              and "task-security-sibling-pool" not in unassigned_ids, unassigned_ids)

        own_assign = await client.post(
            "/api/v1/admin/unassigned/task-security-assignable/assign",
            headers=manager_headers,
            json={"client_id": "client-security-a", "create_binding": False})
        check("department manager can assign global unassigned work in-scope",
              own_assign.status_code == 200
              and own_assign.json().get("task", {}).get("ownerClientId") == "client-security-a",
              own_assign.text)

        own_delete = await client.delete(
            f"/api/v1/admin/bindings/{own_binding_id}", headers=manager_headers)
        check("department manager can delete an in-scope binding",
              own_delete.status_code == 200 and own_delete.json().get("ok") is True,
              own_delete.text)

    async with SessionLocal() as session:
        sibling = await session.get(models.OrgUnit, "org-security-b")
        root = await session.get(models.OrgUnit, "org-security-a")
        leaf = await session.get(models.OrgUnit, leaf_id)
        total = await session.scalar(
            select(func.count()).select_from(models.OrgUnit))
        logs = list((await session.execute(
            select(models.AuditLog).where(
                models.AuditLog.actor_id == "user-security-manager")
            .order_by(models.AuditLog.at)
        )).scalars().all())
        sibling_binding = await session.get(
            models.IntegrationBinding, "binding-security-sibling")
        leaked_binding = await session.scalar(
            select(func.count()).select_from(models.IntegrationBinding).where(
                models.IntegrationBinding.external_actor == "cross-created"))
        assigned_task = await session.get(models.Task, "task-security-assignable")
        sibling_pool_task = await session.get(
            models.Task, "task-security-sibling-pool")
        check("denied writes leave sibling and tree structure unchanged",
              sibling is not None and sibling.name == "外地事业部"
              and root is not None and root.parent_id is None and leaf is None
              and total == 4,
              {"sibling": getattr(sibling, "name", None),
               "rootParent": getattr(root, "parent_id", None),
               "leaf": bool(leaf), "total": total})
        check("denied binding and assignment writes leave no partial state",
              sibling_binding is not None and leaked_binding == 0
              and assigned_task.owner_client_id == "client-security-a"
              and sibling_pool_task.owner_client_id is None,
              {"siblingBinding": bool(sibling_binding), "leaked": leaked_binding,
               "assigned": assigned_task.owner_client_id,
               "siblingPool": sibling_pool_task.owner_client_id})
        token_row = await session.get(models.Integration, created_integration_id)
        check("only the rotated integration token remains authoritative",
              token_row is not None and token_row.ingest_token == rotated_token
              and token_row.ingest_token != first_token,
              getattr(token_row, "ingest_token", None))
        audit_blob = json.dumps([row.detail or {} for row in logs], ensure_ascii=False)
        check("audit details never retain credential plaintext",
              first_token not in audit_blob and rotated_token not in audit_blob
              and "mcp-private-value" not in audit_blob, audit_blob)
        actions = [row.action for row in logs]
        check("successful management writes produce a complete audit trail",
              [action for action in actions if action.startswith("org.")] == [
                  "org.create", "org.update", "org.delete"]
              and all(action in actions for action in (
                  "binding.upsert", "task.assign", "binding.delete", "integration.create",
                  "integration.update", "integration.token.rotate")), actions)


async def run() -> None:
    try:
        await main()
    finally:
        await engine.dispose()


try:
    asyncio.run(run())
finally:
    _tmp.cleanup()

print(f"\nadmin security: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
