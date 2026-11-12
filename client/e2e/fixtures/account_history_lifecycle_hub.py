"""Private loopback Hub for the real account-history HTTP contract test."""
import argparse
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
args = parser.parse_args()
root = Path(args.root).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith("soduwork-history-http-"):
    raise RuntimeError("A private system temporary directory is required")
if not root.is_dir() or (root / ".env").exists():
    raise RuntimeError("The fixture directory must exist and contain no environment file")
os.chdir(root)
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "hub-backend"))
os.environ.update(
    DATABASE_URL="sqlite+aiosqlite:///" + (root / ".smoke-history-http.db").as_posix(),
    AUTH_SECRET=secrets.token_urlsafe(40), ADMIN_PASS=secrets.token_urlsafe(24),
    CLUSTER_REDIS_URL="", SODUWORK_ENV="development", DEVICE_AUTH_COMPAT="false",
    LIBRARY_STORAGE_BACKEND="local", LIBRARY_STORAGE_DIR=str(root / "library"),
)
from app.config import Settings
Settings.model_config["env_file"] = None
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import uvicorn
from app.account_conversation_models import (
    AccountConversation, AccountConversationCursor, AccountConversationMessage,
)
from app.api import account_conversations
from app.auth import verify_claims
from app.db import Base, SessionLocal, engine, get_session
from app.deps import current_client
from app.models import Client, Task
from app.services.device_auth import issue_session

identities = {}
control_key = secrets.token_urlsafe(32)


@asynccontextmanager
async def lifespan(app):
    async with engine.begin() as connection:
        await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
            Client.__table__, Task.__table__, AccountConversationCursor.__table__,
            AccountConversation.__table__, AccountConversationMessage.__table__,
        ]))
    async with SessionLocal() as session:
        for name, owner in (("source", "owner-one"), ("second", "owner-one"),
                            ("reinstalled", "owner-one"), ("stranger", "owner-two")):
            client = Client(id="fixture-" + name, name=name, user_ref=owner,
                            auth_state="active", auth_version=1)
            session.add(client)
            token, _ = issue_session(client)
            identities[name] = {"clientId": client.id, "session": token}
        await session.commit()
    try:
        yield
    finally:
        await engine.dispose()


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def only_loopback(request, call_next):
    if not request.client or request.client.host != "127.0.0.1":
        return JSONResponse({"detail": "Loopback fixture only"}, status_code=403)
    return await call_next(request)


async def fixture_client(request: Request, session=Depends(get_session)):
    # Only authentication is substituted; signatures, account ownership,
    # router validation, database transactions and JSON are exercised for real.
    authorization = request.headers.get("authorization", "")
    claims = verify_claims(authorization.removeprefix("Device "), token_type="device")
    if not authorization.startswith("Device ") or not claims:
        raise HTTPException(401, "Invalid fixture session")
    client = await session.get(Client, claims.get("cid"))
    if not client or client.user_ref != claims.get("uid") or client.auth_state != "active":
        raise HTTPException(403, "Invalid fixture identity")
    return client


app.dependency_overrides[current_client] = fixture_client
app.include_router(account_conversations.router)


@app.post("/__fixture__/shutdown")
async def shutdown(request: Request):
    if request.headers.get("x-fixture-key") != control_key:
        raise HTTPException(403)
    server.should_exit = True
    return {"ok": True}


sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.bind(("127.0.0.1", 0))
server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0,
    access_log=False, log_level="error", proxy_headers=False))


async def main():
    serving = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started:
        if serving.done():
            await serving
            raise RuntimeError("Fixture server failed to start")
        await asyncio.sleep(0.01)
    # This private pipe is consumed by the parent test and never printed there.
    print("HISTORY_FIXTURE_READY " + json.dumps({
        "port": sock.getsockname()[1], "identities": identities, "key": control_key,
    }), flush=True)
    await serving


try:
    asyncio.run(main())
finally:
    sock.close()
