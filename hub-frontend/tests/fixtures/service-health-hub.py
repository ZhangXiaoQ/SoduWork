"""Disposable production Hub routes for service-health-browser.cjs.

Fresh SQLite and a synthetic administrator replace production startup/background
jobs. Login, permissions, health and page APIs use their production handlers.
This fixture does not certify migrations, integrations or deployment readiness.
"""
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
import threading

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
parser.add_argument("--dist", required=True)
parser.add_argument("--watch-parent", action="store_true")
args = parser.parse_args()
root = Path(args.root).resolve()
dist = Path(args.dist).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith("soduwork-service-health-"):
    raise RuntimeError("Use a fresh soduwork-service-health-* temporary directory")
if (root / "hub.db").exists() or not (dist / "index.html").is_file():
    raise RuntimeError("Use a fresh fixture database and a built frontend")
repo = Path(__file__).resolve().parents[3]
os.chdir(root)
sys.path.insert(0, str(repo / "hub-backend"))
from app.config import Settings

Settings.model_config["env_file"] = None
for field in Settings.model_fields:
    os.environ.pop(field.upper(), None)
os.environ.update({
    "DATABASE_URL": "sqlite+aiosqlite:///" + (root / "hub.db").as_posix(),
    "AUTH_SECRET": secrets.token_urlsafe(40), "ADMIN_PASS": secrets.token_urlsafe(32),
    "SODUWORK_ENV": "development", "CLUSTER_REDIS_URL": "",
    "HUB_LOCAL_EXECUTION_ENABLED": "false", "POLL_INTERVAL_SECONDS": "0",
    "SODUWORK_DATA_ROOT": str(root / "data"), "LIBRARY_STORAGE_BACKEND": "local",
    "LIBRARY_STORAGE_DIR": str(root / "library"),
    "SODUWORK_HUB_VERSION": "", "SODUWORK_DEPLOY_COMMIT": "",
})
from fastapi import Request
from fastapi.staticfiles import StaticFiles
from starlette.routing import Mount
from app.main import app
from app.db import Base, engine, SessionLocal
from app.models import User
from app.auth import hash_password
import uvicorn

requests = []
password = secrets.token_urlsafe(24)


async def watch_shutdown():
    while not (root / "shutdown").exists():
        await asyncio.sleep(0.1)
    server.should_exit = True


@asynccontextmanager
async def lifespan(_app):
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with SessionLocal() as db:
        db.add(User(id="fixture-health-admin", username="fixture-health-admin",
                    display_name="Fixture administrator", is_super=True,
                    password_hash=hash_password(password)))
        await db.commit()
    (root / "ready.json").write_text(json.dumps({"origin": f"http://127.0.0.1:{port}",
                                               "username": "fixture-health-admin", "password": password}), encoding="utf-8")
    watcher = asyncio.create_task(watch_shutdown())
    try:
        yield
    finally:
        watcher.cancel()
        await engine.dispose()


app.router.lifespan_context = lifespan


@app.middleware("http")
async def record(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/") or request.url.path == "/healthz":
        requests.append({"method": request.method, "path": request.url.path, "status": response.status_code})
        (root / "requests.json").write_text(json.dumps(requests, indent=2), encoding="utf-8")
    return response


# An alternate immutable build permits the same regression checks before/after a fix.
app.router.routes[:] = [route for route in app.router.routes if not isinstance(route, Mount) or route.path != ""]
app.mount("/", StaticFiles(directory=dist, html=True), name="fixture-frontend")
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
port = sock.getsockname()[1]
server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
if args.watch_parent:
    # The Electron owner keeps this pipe open. A crash/outer timeout closes it,
    # even when its normal shutdown-file cleanup could not run.
    def parent_exited():
        # Avoid holding a buffered-stdin lock during Python finalization when
        # the normal shutdown-file path exits before the parent pipe closes.
        while os.read(sys.stdin.fileno(), 1024):
            pass
        server.should_exit = True
    threading.Thread(target=parent_exited, daemon=True).start()
server.run(sockets=[sock])
