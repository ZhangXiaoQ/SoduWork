"""Isolated HTTP E2E Hub; only the model/Runner boundary is deterministic.

Uses production Task, assignment, attachments, comments, acceptance and library
routers. Never import this module in a deployed Hub.
"""
import time
import importlib
import asyncio
from contextlib import asynccontextmanager, suppress, ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from sqlalchemy import select

from tests import collaboration_browser_server as fixture
from app import automation_models, library_models, session_memory_models
from app.api import tasks, client_auth
from app.services import device_auth
from app.services import (ai_exec, task_execution_model, execution_sessions,
                          task_events, delivery_manifest, task_dispatch, model_catalog)
from app.services import task_notifications
from app.realtime import hub

# The full Hub registers these models before migrations/startup. The isolated
# fixture creates only its disposable schema and must register them too.
for model_file in (Path(__file__).resolve().parents[1] / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)

app = fixture.app
app.include_router(tasks.router)
app.include_router(client_auth.router)
fixture_lifespan = app.router.lifespan_context


@asynccontextmanager
async def authenticated_fixture_lifespan(application):
    async with fixture_lifespan(application):
        async with fixture.sessions() as session:
            session.add(fixture.models.Project(id='e2e-project', name='长期协作项目', org_id='e2e-org', owner_user_id='sender'))
            for key in ('sender', 'recipient', 'other'):
                client = await session.get(fixture.models.Client, 'e2e-' + key)
                client.secret_hash = device_auth.hash_secret('isolated-requirements-fixture-key-never-production')
            session.add(automation_models.RunnerNode(id="fixture-runner", owner_user_id="",
                client_id="e2e-recipient", org_id="e2e-org", auth_state="active", management_state="active"))
            await session.commit()
        # Preserve the real endpoint storage protocol; only socket delivery and
        # cluster routing are loopback fixtures. Hub never retains message bodies.
        import runner_main
        from app.services import local_base, runner_hub, cluster_runtime
        with patch.object(local_base, "_data_root", return_value=str(fixture.root / "runner")):
            endpoint = runner_main.Runner("http://127.0.0.1", "", "fixture-device", "fixture-runner")
        socket = SimpleNamespace()
        node = runner_hub._Runner(socket, {"runnerId": "fixture-runner", "caps": ["conversationContent1"]})
        node.client_id, node.org_id, node.ready = "e2e-recipient", "e2e-org", True

        async def send(packet):
            calls["contentOperations"].append(packet["op"])
            await endpoint._handle_message(packet, socket)

        async def reply(packet):
            node.resolve(packet["id"], packet)

        socket.send_json, endpoint._send = send, reply
        original_get = runner_hub.get
        patches = ExitStack()
        patches.enter_context(patch.object(local_base, "_data_root", return_value=str(fixture.root / "runner")))
        patches.enter_context(patch.object(runner_hub, "get",
            side_effect=lambda rid: node if rid == "fixture-runner" else original_get(rid)))
        patches.enter_context(patch.object(cluster_runtime, "check_owner", AsyncMock()))
        async def drain_notifications():
            while True:
                if not await task_notifications.run_once(fixture.sessions):
                    await asyncio.sleep(0.05)
        worker = asyncio.create_task(drain_notifications())
        try:
            yield
        finally:
            worker.cancel()
            with suppress(asyncio.CancelledError):
                await worker
            patches.close()
            endpoint._admission._journal.close()


app.router.lifespan_context = authenticated_fixture_lifespan
calls = {"dispatches": [], "events": [], "contentOperations": []}
original_publish = hub.publish


async def publish(client_id, event, **kwargs):
    calls["events"].append({"client": client_id, "event": event})
    await original_publish(client_id, event, **kwargs)


hub.publish = publish
ai_exec.load = AsyncMock(return_value={"provider": "local"})
ai_exec.with_task_git = AsyncMock(side_effect=lambda session, ctx, task, **kwargs: ctx)
ai_exec.with_project_context = AsyncMock(side_effect=lambda session, extra, task, repo: extra)
ai_exec.resolve_requested_sync = lambda ctx, aid, *args: {
    "id": aid, "name": "Pi · isolated provider", "cli": "pi", "type": "agent"}
task_execution_model.prepare = AsyncMock(side_effect=lambda session, client, ctx, *args: (ctx, {"model": "deterministic"}))
task_dispatch._settle_work_dir = AsyncMock(return_value={"ok": True, "dir": str(fixture.root / "work"), "workRoot": str(fixture.root / "work")})
ai_exec.list_assignees_sync = lambda ctx: {"agents": [{
    "id": "local:pi", "name": "Pi · isolated provider", "cli": "pi",
    "cliName": "Pi", "type": "agent", "online": True,
}], "squads": []}
ai_exec.model_choices = lambda ctx: {"default": "deterministic", "list": ["deterministic"]}
model_catalog.choices = AsyncMock(return_value={
    "default": "deterministic", "list": ["deterministic"],
    "items": [{"name": "deterministic", "label": "Deterministic fixture"}],
})


def dispatch(ctx, task, files, picked, extra):
    calls["dispatches"].append({"id": task.id, "title": task.title, "note": task.note,
                               "criteria": task.acceptance_criteria,
                               "files": [file[0] for file in files], "brief": extra.get("brief", "")})
    return {"ok": True, "provider": "local", "issueId": "local:fixture-" + task.id,
            "assigneeId": picked["id"], "assigneeName": "Pi · isolated provider", "assigneeCli": "pi",
            "runnerId": "fixture-runner", "runnerVersion": "1.12.55", "files": len(files)}


ai_exec.dispatch_sync = dispatch


@app.get("/e2e/observations")
async def observations():
    return calls


@app.post("/e2e/finish/{task_id}")
async def finish(task_id: str):
    if not any(item["id"] == task_id for item in calls["dispatches"]):
        raise HTTPException(409, "Task was not dispatched")
    async with fixture.sessions() as session:
        task = await session.get(fixture.models.Task, task_id)
        data = ("# 需求交付\n\n" + task.title + "\n\n" + "\n".join(task.acceptance_criteria)).encode("utf-8")
        aid = "output-" + task_id
        key = "att/" + task_id + "/" + aid + "/delivery.md"
        backend = fixture.storage.put(key, data, "text/markdown")
        session.add(fixture.models.Attachment(id=aid, task_id=task_id, filename="delivery.md", role="output",
            content_type="text/markdown", size=len(data), storage_key=key, backend=backend, uploaded_by=task.owner_client_id,
            source_ref="local:fixture-" + task_id,
            evidence_meta={"verification": delivery_manifest.validate_bytes("delivery.md", data, "text/markdown")}))
        task.result = "交付文件与完成标准已生成，等待提出人验收。"
        await session.flush()
        receipt = await execution_sessions.ingest_live_snapshot(session, task, "local:fixture-" + task_id, {
            "ok": True, "status": "done", "runnerId": "fixture-runner", "cli": "pi", "ended": time.time(),
            "seq": 1, "items": [{"kind": "say", "text": task.result, "seq": 1}],
        })
        if not receipt or receipt.get("status") != "done" or receipt.get("persistedThrough") != 1:
            raise RuntimeError("The isolated Runner completion was not retained")
        event = await session.scalar(select(automation_models.ExecutionEvent).where(
            automation_models.ExecutionEvent.session_id == receipt["id"], automation_models.ExecutionEvent.seq == 1))
        if event.text or not event.detail.get("contentRef"):
            raise RuntimeError("The isolated Hub retained a message body instead of an endpoint reference")
        restored = await execution_sessions.read_task(session, task.id, receipt["ref"])
        if restored["items"][0]["text"] != task.result:
            raise RuntimeError("The endpoint conversation did not restore the complete answer")
        task_events.record(session, task_id, "ai.completed", {"ref": "local:fixture-" + task_id}, actor="fixture-provider")
        await session.commit()
    return {"ok": True, "attachmentId": aid}


@app.post("/api/v1/task-execution-options")
async def execution_options():
    return {"substrates": [{"key": "local:pi", "cli": "pi", "name": "Pi", "available": True,
                             "onlineSeats": 1, "modelPick": True}],
            "models": ["deterministic"], "defaultModel": "deterministic",
            "workflows": [], "blockedWorkflows": [], "repos": []}


@app.get("/api/v1/config")
async def config():
    return {}


@app.get("/api/v1/work-catalog")
async def catalog():
    return {"scenarios": []}


@app.get("/e2e/stored")
async def stored():
    async with fixture.sessions() as session:
        rows = (await session.execute(select(fixture.models.Task))).scalars().all()
        return [{"id": task.id, "status": task.status, "title": task.title,
                 "ownerClientId": task.owner_client_id, "criteria": task.acceptance_criteria} for task in rows]
