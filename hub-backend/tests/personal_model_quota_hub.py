"""Owned loopback Hub/provider for the Electron personal-quota regression.

Only deterministic provider responses and fixture setup are synthetic. Production
routers, authentication, model resolution, transport and SQLite accounting run.
The fixture never reads a deployment .env or accepts non-loopback control calls.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import threading

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
args = parser.parse_args()
root = Path(args.root).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith("soduwork-personal-quota-"):
    raise RuntimeError("A dedicated system temporary directory is required")
os.chdir(root)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.update(
    DATABASE_URL="sqlite+aiosqlite:///" + (root / "hub.sqlite").as_posix(),
    AUTH_SECRET=secrets.token_urlsafe(40), ADMIN_PASS=secrets.token_urlsafe(24),
    SODUWORK_ENV="development", DEVICE_AUTH_COMPAT="false", CLUSTER_REDIS_URL="",
    LIBRARY_STORAGE_BACKEND="local", LIBRARY_STORAGE_DIR=str(root / "library"),
    MINIO_ENDPOINT="", LIBRARY_MINIO_ENDPOINT="", LIBRARY_NFS_HOST="",
)
from app.config import Settings
Settings.model_config["env_file"] = None
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from app.main import app as production_app
from app import models
from app.auth import hash_password, sign_token
from app.db import Base, SessionLocal, engine
from app.services import client_access, device_auth, model_transport

control_key = secrets.token_urlsafe(32)
password = secrets.token_urlsafe(24)
platform_key = secrets.token_urlsafe(24)
personal_key = secrets.token_urlsafe(24)
requests = []
http_receipts = []
provider = FastAPI()
app = FastAPI()
servers = []
user_id = "personal-quota-owner"


def control(request):
    if request.client.host not in ("127.0.0.1", "::1") or request.headers.get("x-fixture-key") != control_key:
        raise HTTPException(403)


@app.middleware("http")
async def receipt(request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/__fixture__"):
        http_receipts.append({"method": request.method, "path": request.url.path, "status": response.status_code})
    return response


@provider.get("/v1/models")
async def list_models():
    return {"data": [{"id": name} for name in ("platform-model", "personal-model", "keyless-model")]}


@provider.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    auth = request.headers.get("authorization", "")
    key_kind = ("platform" if auth == "Bearer " + platform_key else
                "personal" if auth == "Bearer " + personal_key else
                "none" if auth in ("", "Bearer soduwork-local-no-key") else "unexpected")
    if key_kind == "unexpected":
        raise HTTPException(401, "Unexpected fixture credential")
    messages = body.get("messages", [])
    user = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
    calls_after_user = []
    for message in reversed(messages):
        if message.get("role") == "user":
            break
        calls_after_user.extend(message.get("tool_calls") or [])
    count = len(calls_after_user)
    result = {"text": "Fixture model response."}
    if "quota fixture draft" in str(user):
        result = ({"tool": "write", "args": {"path": "plugin-draft.txt",
                   "content": "QUOTA_DRAFT_MARKER: keep this task and its tool output.\n"}}
                  if count == 0 else {"text": "Draft saved. Continue this plugin in the same conversation."})
    elif "quota fixture continue" in str(user):
        if "QUOTA_DRAFT_MARKER" not in json.dumps(messages):
            raise HTTPException(409, "Continuation lost the earlier draft tool arguments")
        if count == 0:
            result = {"tool": "write", "args": {"path": "plugin.json", "content": json.dumps({
                "id": "quota-continuation-fixture", "name": "Quota continuation", "version": "1.0.0",
                "description": "Isolated deterministic continuation", "entry": "index.html"})}}
        elif count == 1:
            result = {"tool": "write", "args": {"path": "index.html",
                "content": "<!doctype html><title>Quota continuation</title><h1>PERSONAL_CONTINUATION_MARKER</h1>"}}
        else:
            result = {"text": "PERSONAL_CONTINUATION_COMPLETE: retained draft and generated plugin files."}
    elif "quota fixture resume" in str(user):
        history = json.dumps(messages)
        if not all(marker in history for marker in ("QUOTA_DRAFT_MARKER", "PERSONAL_CONTINUATION_COMPLETE", "plugin.json", "index.html")):
            raise HTTPException(409, "Resumed archive lost earlier messages or tool results")
        result = {"text": "RESUMED_CONTEXT_COMPLETE: retained prior messages and tools without repeating them."}
    requests.append({"model": body.get("model"), "keyKind": key_kind,
                     "messages": messages, "tool": result.get("tool"), "args": result.get("args")})
    index = len(requests)
    delta = ({"role": "assistant", "tool_calls": [{"index": 0, "id": "fixture_call_" + str(index),
              "type": "function", "function": {"name": result["tool"], "arguments": json.dumps(result["args"])}}]}
             if "tool" in result else {"role": "assistant", "content": result["text"]})
    usage = {"prompt_tokens": 20, "completion_tokens": 8, "total_tokens": 28}
    if not body.get("stream"):
        return {"id": "quota-fixture-" + str(index), "object": "chat.completion", "model": body.get("model"),
                "choices": [{"index": 0, "message": delta, "finish_reason": "stop"}], "usage": usage}

    async def stream():
        for part, finish, usage_part in [(delta, None, None), ({}, "tool_calls" if "tool" in result else "stop", usage)]:
            payload = {"id": "quota-fixture-" + str(index), "object": "chat.completion.chunk",
                       "model": body.get("model"), "choices": [{"index": 0, "delta": part, "finish_reason": finish}]}
            if usage_part:
                payload["usage"] = usage_part
            yield "data: " + json.dumps(payload) + "\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/__fixture__/state")
async def state(request: Request):
    control(request)
    async with SessionLocal() as session:
        daily = list((await session.scalars(select(models.AIUsageDaily).where(
            models.AIUsageDaily.billing_user_id == user_id))).all())
        quota = await client_access.quota_status(session, user_id)
    return {"quota": quota, "daily": [{"model": row.model, "provider": row.provider,
            "tokens": row.total_tokens, "scope": getattr(row, "quota_scope", "platform"),
            "event": row.usage_event_id} for row in daily], "providerRequests": requests,
            "http": http_receipts}


@app.post("/__fixture__/account")
async def account(request: Request):
    control(request)
    body = await request.json()
    async with SessionLocal() as session:
        user = await session.get(models.User, user_id)
        if "active" in body:
            user.is_active = bool(body["active"])
        await session.commit()
    return {"ok": True}


@app.post("/__fixture__/shutdown")
async def shutdown(request: Request):
    control(request)
    for server, _, _ in servers:
        server.should_exit = True
    return {"ok": True}


async def serve(application):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(application, log_level="error", access_log=False,
                                          lifespan="off", timeout_graceful_shutdown=3))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    servers.append((server, task, sock))
    async with asyncio.timeout(10):
        while not server.started:
            if task.done():
                await task
            await asyncio.sleep(.02)
    return "http://127.0.0.1:" + str(port)


async def main():
    provider_url = await serve(provider)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with SessionLocal() as session:
        session.add_all([
            models.OrgUnit(id="quota-fixture-org", name="Isolated quota organization"),
            models.User(id=user_id, username="quota-fixture", org_id="quota-fixture-org",
                        password_hash=hash_password(password), is_active=True),
            models.User(id="quota-fixture-admin", username="quota-fixture-admin", is_super=True),
            models.User(id="quota-fixture-foreign", username="quota-fixture-foreign", is_active=True),
            models.ModelProvider(id="fixture-platform", name="Fixture platform", kind="openai-compat",
                                 base_url=provider_url + "/v1", api_key=platform_key),
            models.ModelDef(id="fixture-platform:platform-model", provider_id="fixture-platform",
                            name="platform-model", label="Platform fixture model"),
            models.ModelDef(id="fixture-platform:platform-other", provider_id="fixture-platform",
                            name="platform-other", label="Another platform fixture model"),
        ])
        foreign = models.Client(id="quota-fixture-foreign-device")
        device_auth.activate(foreign, await session.get(models.User, "quota-fixture-foreign"))
        session.add(foreign)
        await session.commit()
        foreign_token, _ = device_auth.issue_session(foreign)
    hub = await serve(app)
    ready = {"hub": hub, "provider": provider_url, "controlKey": control_key, "account": "quota-fixture",
             "password": password, "userId": user_id, "personalKey": personal_key,
             "adminToken": sign_token("quota-fixture-admin"), "foreignToken": foreign_token}
    (root / "ready.json").write_text(json.dumps(ready), encoding="utf-8")
    print("PERSONAL_QUOTA_FIXTURE_READY", flush=True)

    def parent_watch():
        while os.read(sys.stdin.fileno(), 4096):
            pass
        for server, _, _ in servers:
            server.should_exit = True
    threading.Thread(target=parent_watch, daemon=True).start()
    try:
        await asyncio.gather(*(task for _, task, _ in servers))
    finally:
        for server, _, _ in servers:
            server.should_exit = True
        await model_transport.shutdown()
        await engine.dispose()
        for _, _, sock in servers:
            sock.close()


app.mount("/", production_app)
asyncio.run(main())
