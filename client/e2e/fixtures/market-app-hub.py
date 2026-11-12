"""Loopback-only Hub fixture: production plugin APIs and an isolated in-memory DB."""
import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
import socket
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "hub-backend"))
import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app import models, automation_models as am
from app.db import Base, get_session
from app.deps import current_client
from app.api import plugin_client_catalog
from app.services import plugin_drafts, plugin_packages, plugin_service, plugin_installations

origin = sys.argv[1]
engine = create_async_engine("sqlite+aiosqlite:///:memory:")
sessions = async_sessionmaker(engine, expire_on_commit=False)
temporary = tempfile.TemporaryDirectory(prefix="soduwork-market-hub-")
plugin_packages.package_root = lambda: temporary.name
state = {}


async def session_dependency():
    async with sessions() as session:
        yield session


async def client_dependency(authorization: str = Header(default=""), session=Depends(session_dependency)):
    if authorization != "Device fixture-session":
        raise HTTPException(status_code=401)
    return await session.get(models.Client, "fixture-device")


@asynccontextmanager
async def lifespan(_app):
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        user = models.User(id="fixture-user", username="fixture-user", org_id="fixture-org")
        session.add_all([models.OrgUnit(id="fixture-org", name="Fixture"), user,
                        models.Client(id="fixture-device", user_ref=user.id, auth_state="active")])
        await session.commit()
        package = plugin_drafts.build({"template": "app", "key": "market-fixture", "name": "Fixture app",
            "version": "1.0.0", "description": "Isolated application", "instructions": "Fixture only",
            "mcpServers": ["fixture-business"],
            "resources": [{"path": "references/policy.md", "kind": "reference",
                           "encoding": "utf8", "content": "Fixture policy"}],
            "ui": {"contributions": [{"id": "main", "title": "Fixture", "slot": "workspace.navigation",
                "source": {"type": "external", "url": origin + "/", "bridge": {"version": 1,
                    "capabilities": ["mcp.connect", "settings.read", "settings.write"]}}}]}})
        installed = await plugin_service.install(session, package, user, user.org_id,
                                                 source_channel="personal-publish")
        version = await session.get(am.PluginVersion, installed["versionId"])
        await plugin_service.approve_version(session, version, True, "Fixture reviewer")
        session.add(am.PluginCatalogPolicy(plugin_id=version.plugin_id, installation="available",
                                          authentication="on_install"))
        await session.commit()
        state.update(pluginId=version.plugin_id, versionId=version.id)
    yield
    await engine.dispose()
    temporary.cleanup()


app = FastAPI(lifespan=lifespan)
app.include_router(plugin_client_catalog.router)
app.dependency_overrides[get_session] = session_dependency
app.dependency_overrides[current_client] = client_dependency


@app.get("/fixture/ready")
async def ready():
    return state


@app.post("/fixture/uninstall")
async def uninstall(client=Depends(client_dependency), session=Depends(session_dependency)):
    await plugin_installations.uninstall(session, client.user_ref, state["pluginId"])
    return {"ok": True}


@app.post("/fixture/preflight")
async def preflight(client=Depends(client_dependency), session=Depends(session_dependency)):
    version = await session.get(am.PluginVersion, state["versionId"])
    return await plugin_service.simulate(session, version, None, "fixture-org", binding_config={})


if __name__ == "__main__":
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    print(json.dumps({"hub": "http://127.0.0.1:" + str(sock.getsockname()[1])}), flush=True)
    uvicorn.Server(uvicorn.Config(app, log_level="warning")).run(sockets=[sock])
