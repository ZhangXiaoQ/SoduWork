"""Focused smoke test for stable plugin identities and immutable versions."""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
WORK = Path(tempfile.mkdtemp(prefix="smoke-plugin-identity-"))
DB = WORK / "identity.db"
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.as_posix()
os.environ["SODUWORK_DATA_ROOT"] = str(WORK / "data")
sys.path.insert(0, str(ROOT))

from sqlalchemy import inspect, select  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402

from app import automation_models as am  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.services import plugin_identity, plugin_packages  # noqa: E402

checks = 0


def ok(condition: bool, message: str) -> None:
    global checks
    if not condition:
        raise AssertionError(message)
    checks += 1


def plugin(org_id: str | None, key: str) -> am.Plugin:
    return am.Plugin(
        org_id=org_id, key=key, name=key, description="",
        source_kind="soduwork", enabled=False, created_by="smoke")


def version(plugin_id: str, number: str, checksum: str) -> am.PluginVersion:
    return am.PluginVersion(
        plugin_id=plugin_id, version=number, checksum=checksum,
        manifest={"key": "identity-smoke", "version": number},
        workflow={}, capability_report={}, provenance={}, package_path="",
        trust_state="quarantined", visibility="organization",
        enabled=False, created_by="smoke")


async def rejected(row) -> bool:
    async with SessionLocal() as session:
        session.add(row)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            return True
    return False


async def main() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        indexes = await connection.run_sync(lambda sync: {
            table: {item["name"]: bool(item.get("unique"))
                    for item in inspect(sync).get_indexes(table)}
            for table in ("automation_plugin", "automation_plugin_version")
        })

    expected_plugin = {
        "uq_automation_plugin_platform_key",
        "uq_automation_plugin_org_key",
    }
    expected_version = {
        "uq_automation_plugin_version_name",
        "uq_automation_plugin_version_checksum",
    }
    ok(all(indexes["automation_plugin"].get(name) is True
           for name in expected_plugin),
       "plugin scope identities are not protected by unique indexes")
    ok(all(indexes["automation_plugin_version"].get(name) is True
           for name in expected_version),
       "plugin immutable versions are not protected by unique indexes")
    payload = b"one immutable plugin package"
    package = {
        "manifest": {"key": "identity-smoke"},
        "checksum": hashlib.sha256(payload).hexdigest(),
        "bytes": payload,
    }
    with ThreadPoolExecutor(max_workers=8) as pool:
        paths = list(pool.map(lambda _index: plugin_packages.store(package), range(16)))
    stored_path = Path(paths[0])
    ok(len(set(paths)) == 1 and stored_path.read_bytes() == package["bytes"],
       "parallel package writes did not converge on one verified artifact")
    ok(not list(stored_path.parent.glob("*.tmp")),
       "parallel package writes left temporary artifacts behind")

    async with SessionLocal() as session:
        platform, made_platform = await plugin_identity.get_or_create_plugin(
            session, org_id=None, key="identity-smoke", name="Identity Smoke",
            description="", source_kind="builtin", created_by="smoke")
        platform_again, made_again = await plugin_identity.get_or_create_plugin(
            session, org_id=None, key="identity-smoke", name="Ignored Rename",
            description="", source_kind="builtin", created_by="smoke")
        org_a, made_org_a = await plugin_identity.get_or_create_plugin(
            session, org_id="org-a", key="identity-smoke", name="Org A",
            description="", source_kind="soduwork", created_by="smoke")
        org_b, made_org_b = await plugin_identity.get_or_create_plugin(
            session, org_id="org-b", key="identity-smoke", name="Org B",
            description="", source_kind="soduwork", created_by="smoke")
        await session.commit()
        platform_id = platform.id
        org_a_id = org_a.id
        ok(made_platform and not made_again and platform.id == platform_again.id,
           "repeated platform registration did not reuse the stable identity")
        ok(made_org_a and made_org_b and org_a.id != org_b.id,
           "the same key must remain valid in different organizations")
        ok(plugin_identity.public(platform) == {
            "scope": "platform", "qualifiedKey": "soduwork/identity-smoke"},
           "platform public identity is not canonical")
        ok(plugin_identity.public(org_a) == {
            "scope": "organization",
            "qualifiedKey": "org:org-a/identity-smoke"},
           "organization public identity is not canonical")

    ok(await rejected(plugin(None, "identity-smoke")),
       "database accepted a duplicate platform plugin key")
    ok(await rejected(plugin("org-a", "identity-smoke")),
       "database accepted a duplicate organization plugin key")

    async with SessionLocal() as session:
        stored, created = await plugin_identity.insert_version_once(
            session, version(platform_id, "1.0.0", "a" * 64))
        await session.commit()
        stored_id = stored.id
        ok(created, "first immutable version was not created")

    async with SessionLocal() as session:
        same, created = await plugin_identity.insert_version_once(
            session, version(platform_id, "1.0.0", "a" * 64))
        ok(not created and same.id == stored_id,
           "identical package import did not reuse the immutable version")
        conflict = False
        try:
            await plugin_identity.insert_version_once(
                session, version(platform_id, "1.0.0", "b" * 64))
        except plugin_identity.PluginVersionConflict:
            conflict = True
        ok(conflict, "changed content reused an existing semantic version")

    ok(await rejected(version(platform_id, "2.0.0", "a" * 64)),
       "database accepted a duplicate package checksum for one plugin")
    ok(await rejected(version(platform_id, "1.0.0", "c" * 64)),
       "database accepted a duplicate semantic version for one plugin")

    async with SessionLocal() as session:
        found = (await session.execute(select(am.Plugin).where(
            am.Plugin.id == org_a_id))).scalar_one_or_none()
        ok(found is not None and found.org_id == "org-a",
           "organization plugin identity was not persisted")


try:
    asyncio.run(main())
    print(f"plugin identity: {checks} checks passed")
finally:
    try:
        asyncio.run(engine.dispose())
    except Exception:
        pass
    shutil.rmtree(WORK, ignore_errors=True)
