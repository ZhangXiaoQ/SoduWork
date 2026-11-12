"""Real multipart/import regressions with isolated files, SQLite and signing keys."""
from __future__ import annotations

import asyncio
import base64
import gc
import hashlib
import inspect
import json
import ntpath
import os
import secrets
import subprocess
import tempfile
import threading
import unittest
import uuid
from pathlib import Path, PurePosixPath, PureWindowsPath
from types import SimpleNamespace
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ.setdefault("AUTH_SECRET", secrets.token_urlsafe(32))
os.environ.setdefault("ADMIN_PASS", secrets.token_urlsafe(24))

import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import main as application
from app.api import client_updates as api
from app.db import Base, get_session
from app.models import AuditLog, ClientRelease
from app.services import client_release_files as files
from app.services import client_updates as contract


class ArtifactPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-artifact-path-")
        self.base = Path(self.temp.name).resolve()
        self.addCleanup(self.temp.cleanup)
        self.root = self.base / "releases"
        self.root.mkdir()
        self.settings = SimpleNamespace(client_update_dir=str(self.root))
        settings = patch.object(contract, "get_settings", return_value=self.settings)
        settings.start()
        self.addCleanup(settings.stop)

    def test_namespace_preserves_path_semantics_and_only_converts_absolute_windows_paths(self):
        cases = [
            (PureWindowsPath(r"C:\release root\trailing.\space "),
             PureWindowsPath(r"\\?\C:\release root\trailing.\space ")),
            (PureWindowsPath(r"\\server\share\releases"),
             PureWindowsPath(r"\\?\UNC\server\share\releases")),
        ]
        for source, expected in cases:
            with self.subTest(source=str(source)):
                actual = contract._artifact_path_namespace(source)
                self.assertEqual(actual, expected)
                self.assertEqual(type(actual), type(source))
                self.assertEqual(contract._artifact_path_namespace(actual), actual)
        for source in [PurePosixPath("/release root/trailing./space "),
                       PureWindowsPath(r"C:relative"), PureWindowsPath(r"relative\path"),
                       PureWindowsPath(r"\\.\C:\releases"),
                       PureWindowsPath(r"\\?\C:\releases"),
                       PureWindowsPath(r"\\?\UNC\server\share\releases")]:
            with self.subTest(unchanged=str(source)):
                self.assertIs(contract._artifact_path_namespace(source), source)

    def test_normal_missing_and_existing_paths_stay_inside_the_resolved_root(self):
        raw = "stable/linux/x64/9.9.1/SoduWork-9.9.1-linux.rpm"
        target = contract.safe_artifact_path(raw)
        target.parent.mkdir(parents=True)
        target.write_bytes(b"isolated artifact")
        self.assertTrue(contract.safe_artifact_path(raw).samefile(target))
        self.assertTrue(target.parent.samefile(self.root / "stable/linux/x64/9.9.1"))
        # Existing leading-slash normalization remains a root-relative contract.
        self.assertTrue(contract.safe_artifact_path("/" + raw).samefile(target))
        for invalid in ["", "../outside", "stable/../outside", "..\\outside", "stable//file"]:
            with self.subTest(invalid=invalid), self.assertRaises(contract.UpdateContractError):
                contract.safe_artifact_path(invalid)

    @unittest.skipUnless(os.name == "nt", "Windows canonical path namespaces")
    def test_explicit_extended_root_and_absolute_inputs_cannot_escape(self):
        extended = contract._artifact_path_namespace(self.root)
        self.settings.client_update_dir = str(extended)
        target = contract.safe_artifact_path("artifact.rpm")
        self.assertEqual(target, extended / "artifact.rpm")
        outside = self.base / "outside.rpm"
        outside.write_bytes(b"outside fixture marker")
        with self.assertRaises(contract.UpdateContractError):
            contract.safe_artifact_path(str(outside))
        # UNC-shaped input retains the existing leading-slash normalization.
        unc = contract.safe_artifact_path(r"\\fixture-server\fixture-share\artifact.rpm")
        self.assertEqual(unc.relative_to(extended), Path("fixture-server/fixture-share/artifact.rpm"))

    @unittest.skipUnless(os.name == "nt", "Windows realpath missing-parent race")
    def test_real_parent_creation_between_os_queries_keeps_artifact_containment(self):
        raw = "stable/linux/x64/9.9.1/SoduWork-9.9.1-linux.rpm"
        target = self.root / raw
        original = ntpath._getfinalpathname
        release_creator = threading.Event()
        created = threading.Event()
        errors = []
        creator_errors = []

        def create_parent():
            try:
                if not release_creator.wait(5):
                    raise AssertionError("the initial real OS query did not occur")
                target.parent.mkdir(parents=True)
            except Exception as error:
                creator_errors.append(error)
            finally:
                created.set()

        def observe(path):
            value = os.fspath(path)
            comparison = value[4:] if value.startswith("\\\\?\\") else value
            exact_target = ntpath.normcase(comparison) == ntpath.normcase(str(target))
            try:
                return original(path)
            except OSError as error:
                if exact_target:
                    errors.append(error.winerror)
                    if len(errors) == 1:
                        # Coordinate real mkdir; do not synthesize any OS result.
                        release_creator.set()
                        self.assertTrue(created.wait(5), "synthetic parent creation did not finish")
                        self.assertFalse(creator_errors)
                raise

        worker = threading.Thread(target=create_parent, daemon=True)
        worker.start()
        try:
            with patch.object(ntpath, "_getfinalpathname", observe):
                result = contract.safe_artifact_path(raw)
            self.assertEqual(errors[0], 3)
            self.assertIn(2, errors[1:])
            self.assertTrue(result.parent.samefile(target.parent))
            self.assertEqual(result.name, target.name)
            self.assertFalse(result.exists())
        finally:
            release_creator.set()
            worker.join(timeout=6)
            self.assertFalse(worker.is_alive())
            self.assertFalse(creator_errors)

    def test_real_directory_link_outside_root_is_rejected_without_touching_its_target(self):
        outside = self.base / "outside"
        outside.mkdir()
        marker = outside / "artifact.rpm"
        marker.write_bytes(b"outside fixture marker")
        link = self.root / "escape"
        if os.name == "nt":
            result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(outside)],
                                    capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            link.symlink_to(outside, target_is_directory=True)
        try:
            self.assertTrue((link / marker.name).samefile(marker))
            with self.assertRaises(contract.UpdateContractError):
                contract.safe_artifact_path("escape/" + marker.name)
        finally:
            if os.name == "nt":
                link.rmdir()
            else:
                link.unlink()
        self.assertTrue(outside.is_dir())
        self.assertEqual(marker.read_bytes(), b"outside fixture marker")


class UploadIOTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-upload-io-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.release_root = self.root / "releases"
        self.engine = create_async_engine("sqlite+aiosqlite:///" + (self.root / "isolated.db").as_posix())
        self.loop_thread = threading.get_ident()

        class ConfinedSession(AsyncSession):
            async def execute(inner, *args, **kwargs):
                self.assertEqual(threading.get_ident(), self.loop_thread)
                return await super().execute(*args, **kwargs)

            async def get(inner, *args, **kwargs):
                self.assertEqual(threading.get_ident(), self.loop_thread)
                return await super().get(*args, **kwargs)

            async def commit(inner):
                self.assertEqual(threading.get_ident(), self.loop_thread)
                return await super().commit()

        self.sessions = async_sessionmaker(self.engine, class_=ConfinedSession, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda connection: Base.metadata.create_all(
                connection, tables=[ClientRelease.__table__, AuditLog.__table__]))
        # Concurrent integrity errors can retain SQLite cursor/traceback cycles.
        # Release these after disposal and before deleting the isolated database.
        self.addCleanup(gc.collect)
        self.addAsyncCleanup(self.engine.dispose)
        key = Ed25519PrivateKey.generate()
        self.private = base64.b64encode(key.private_bytes(
            serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
            serialization.NoEncryption())).decode("ascii")
        public = base64.b64encode(key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode("ascii")
        self.key_id = "upload-io-test-key"
        self.patch(contract, "release_root", return_value=self.release_root)
        self.patch(contract, "trusted_public_keys", return_value={self.key_id: public})
        self.patch(application, "SessionLocal", self.sessions)
        self.app = FastAPI()
        self.app.include_router(api.admin_router)
        # These are the production handlers, on the same loop as the upload.
        self.app.add_api_route("/healthz", application.healthz)
        self.app.add_api_route("/readyz", application.readyz)

        async def database():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = database
        for endpoint in [api.upload_manual_client_release, api.set_client_release_enabled]:
            dependency = inspect.signature(endpoint).parameters["user"].default.dependency
            self.app.dependency_overrides[dependency] = lambda: SimpleNamespace(id="fixture-user")
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://fixture")
        self.addAsyncCleanup(self.client.aclose)

    def patch(self, target, name, *args, **kwargs):
        item = patch.object(target, name, *args, **kwargs)
        result = item.start()
        self.addCleanup(item.stop)
        return result

    def bundle(self, version="9.9.1", data=None):
        data = data or b"signed client upload fixture\n" * 50000
        name = f"SoduWork-{version}-Setup.exe"
        release_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "upload-io/" + version))
        payload = {"schema": 1, "releaseId": release_id, "version": version,
                   "channel": "stable", "platform": "win32", "arch": "x64",
                   "artifact": {"name": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                                "url": f"/api/v1/client-updates/artifacts/{release_id}"},
                   "mandatory": False, "minVersion": "", "notes": "isolated upload IO regression",
                   "publishedAt": "2026-11-04T00:00:00Z", "keyId": self.key_id}
        return data, {**payload, "signature": contract.sign(payload, self.private)}

    async def upload(self, data, bundle):
        return await self.client.post("/api/v1/admin/client-releases/upload", files={
            "bundle": ("release.json", json.dumps(bundle).encode(), "application/json"),
            "installer": (bundle["artifact"]["name"], data, "application/octet-stream")})

    async def assert_stored(self, bundle):
        async with self.sessions() as session:
            row = await session.get(ClientRelease, bundle["releaseId"])
            self.assertIsNotNone(row)
            self.assertFalse(row.enabled)
            self.assertEqual(contract.signed_manifest(row), bundle)
            path = contract.safe_artifact_path(row.artifact_path)
            self.assertEqual(path.stat().st_size, bundle["artifact"]["size"])
            self.assertEqual(contract.sha256_file(path), bundle["artifact"]["sha256"])
        self.assertEqual(list((self.release_root / ".incoming").iterdir()), [])

    async def while_worker_held(self, target, name, operation):
        entered = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        original = getattr(target, name)
        timed_out = []
        first = True

        def held(*args, **kwargs):
            nonlocal first
            if first:
                first = False
                loop.call_soon_threadsafe(entered.set)
                if not release.wait(5):
                    timed_out.append(True)
            return original(*args, **kwargs)

        with patch.object(target, name, held):
            pending = asyncio.create_task(operation())
            try:
                await asyncio.wait_for(entered.wait(), 6)
                self.assertFalse(timed_out, "file work blocked the event loop")
                self.assertFalse(pending.done(), "upload must still be waiting on file IO")
                for route, key in [("/healthz", "ok"), ("/readyz", "ready")]:
                    response = await asyncio.wait_for(self.client.get(route), 1)
                    self.assertEqual(response.status_code, 200)
                    self.assertTrue(response.json()[key])
                self.assertFalse(pending.done())
            finally:
                release.set()
                result = await pending
        self.assertFalse(timed_out)
        return result

    async def test_real_upload_keeps_health_responsive_during_hash_copy_and_fsync(self):
        for index, (target, name) in enumerate([
            (contract, "sha256_file"), (contract.shutil, "copyfile"), (files.os, "fsync")]):
            with self.subTest(phase=name):
                data, bundle = self.bundle(f"9.9.{index + 1}")
                response = await self.while_worker_held(target, name, lambda: self.upload(data, bundle))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()["created"])
                await self.assert_stored(bundle)

    async def test_duplicate_upload_and_activation_verify_off_loop_without_weakening_signatures(self):
        data, bundle = self.bundle()
        self.assertEqual((await self.upload(data, bundle)).status_code, 200)
        duplicate = await self.while_worker_held(contract, "sha256_file", lambda: self.upload(data, bundle))
        self.assertEqual(duplicate.status_code, 200)
        self.assertFalse(duplicate.json()["created"])
        contract._ARTIFACT_VERIFIED.clear()
        activated = await self.while_worker_held(contract, "sha256_file", lambda: self.client.patch(
            "/api/v1/admin/client-releases/" + bundle["releaseId"], json={"enabled": True}))
        self.assertEqual(activated.status_code, 200)
        self.assertTrue(activated.json()["release"]["enabled"])
        changed = dict(bundle, signature="A" * 88)
        self.assertEqual((await self.upload(data, changed)).status_code, 409)
        corrupt = data[:-1] + b"!"
        self.assertEqual((await self.upload(corrupt, bundle)).status_code, 409)

    async def test_repeated_cancel_drains_file_worker_before_closing_or_removing_input(self):
        data, bundle = self.bundle()
        started = asyncio.Event()
        release = threading.Event()
        captured = {}
        original = files.copy_upload
        loop = asyncio.get_running_loop()

        def held(source, incoming, limit):
            original(source, incoming, limit)
            captured.update(source=source, incoming=incoming)
            loop.call_soon_threadsafe(started.set)
            if not release.wait(5):
                raise AssertionError("test did not release upload worker")

        with patch.object(files, "copy_upload", held):
            pending = asyncio.create_task(self.upload(data, bundle))
            try:
                await asyncio.wait_for(started.wait(), 2)
                for _ in range(2):
                    pending.cancel()
                    await asyncio.sleep(0.01)
                    self.assertFalse(pending.done())
                    self.assertFalse(captured["source"].closed)
                    self.assertTrue(captured["incoming"].is_file())
            finally:
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
        self.assertFalse(captured["incoming"].exists())
        self.assertFalse(captured["incoming"].parent.exists())
        self.assertTrue(captured["source"].closed)
        async with self.sessions() as session:
            self.assertIsNone(await session.get(ClientRelease, bundle["releaseId"]))

    async def test_worker_failure_removes_incoming_and_size_limit_stays_enforced(self):
        data, bundle = self.bundle()
        original = files.copy_upload

        def broken(source, incoming, limit):
            original(source, incoming, limit)
            raise OSError("fixture storage failure")

        with patch.object(files, "copy_upload", broken):
            with self.assertRaisesRegex(OSError, "fixture storage failure"):
                await self.upload(data, bundle)
        self.assertEqual(list((self.release_root / ".incoming").iterdir()), [])
        limited = lambda source, incoming, limit: original(source, incoming, 1024)
        with patch.object(files, "copy_upload", limited):
            response = await self.upload(data, bundle)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(list((self.release_root / ".incoming").iterdir()), [])

    async def test_database_failure_keeps_verified_bytes_for_safe_retry(self):
        data, bundle = self.bundle()
        source = self.root / bundle["artifact"]["name"]
        source.write_bytes(data)
        async with self.sessions() as session:
            with patch.object(session, "commit", side_effect=RuntimeError("fixture transaction failure")):
                with self.assertRaisesRegex(RuntimeError, "fixture transaction failure"):
                    await contract.import_signed_release(session, bundle, source)
            self.assertIsNone(await session.get(ClientRelease, bundle["releaseId"]))
        target = self.release_root / "stable/win32/x64/9.9.1" / source.name
        self.assertEqual(contract.sha256_file(target), bundle["artifact"]["sha256"])
        async with self.sessions() as session:
            row, created = await contract.import_signed_release(session, bundle, source)
            self.assertTrue(created)
            self.assertEqual(row.id, bundle["releaseId"])
            self.assertEqual(contract.signed_manifest(row), bundle)

    async def test_concurrent_same_package_is_idempotent_and_other_bytes_conflict(self):
        data, bundle = self.bundle()
        copying = asyncio.Event()
        second_store = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        original_copy = contract.shutil.copyfileobj
        original_store = contract._store_release_artifact
        stores = 0

        def held_copy(source, target, *args, **kwargs):
            target.write(source.read(64))
            target.flush()  # Make the partial final file visible to a competing worker.
            loop.call_soon_threadsafe(copying.set)
            if not release.wait(5):
                raise AssertionError("test did not release final artifact copy")
            return original_copy(source, target, *args, **kwargs)

        def store(*args):
            nonlocal stores
            stores += 1
            if stores == 2:
                loop.call_soon_threadsafe(second_store.set)
            return original_store(*args)

        with patch.object(contract.shutil, "copyfileobj", held_copy), \
                patch.object(contract, "_store_release_artifact", store):
            first = asyncio.create_task(self.upload(data, bundle))
            second = None
            try:
                await asyncio.wait_for(copying.wait(), 2)
                second = asyncio.create_task(self.upload(data, bundle))
                await asyncio.wait_for(second_store.wait(), 2)
                self.assertFalse(first.done())
                response = await asyncio.wait_for(self.client.get("/readyz"), 1)
                self.assertEqual(response.status_code, 200)
            finally:
                release.set()
                responses = await asyncio.gather(*([first, second] if second else [first]))
        self.assertEqual([response.status_code for response in responses], [200, 200])
        self.assertEqual(sorted(response.json()["created"] for response in responses), [False, True])
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(func.count(ClientRelease.id))), 1)
        await self.assert_stored(bundle)
        changed, changed_bundle = self.bundle(data=b"other signed content\n" * 70000)
        self.assertEqual((await self.upload(changed, changed_bundle)).status_code, 409)
        await self.assert_stored(bundle)


if __name__ == "__main__":
    unittest.main()
