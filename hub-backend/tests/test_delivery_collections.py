"""Real HTTP/SQLite/filesystem checks for durable, cross-device final results."""
import hashlib
import asyncio
import codecs
import io
import json
import os
from pathlib import Path
import shutil
import stat
import socket
import tempfile
import unittest
from unittest.mock import patch
import zipfile

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import FastAPI, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api import deliveries, library
from app.automation_models import (ExecutionSession, ArtifactVersion, ApprovalRequest,
    ApprovalDecision, ApprovalAssignment, DeploymentRun, WorkflowRun)
from app.conversation_handoff_models import ConversationHandoff
from app.db import Base, get_session
from app.deps import current_client
from app.library_models import LibraryFolder, LibraryItem
from app.models import Attachment, Client, Task, TaskEvent
from app.services import cloud_deliveries, delivery_collections as svc, delivery_manifest, library_storage, storage
from test_unified_requirements import _schema_template


def entry(name, data, role="primary", mime="text/plain"):
    return {"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "contentType": mime, "role": role}


def archive_bytes(files, *, compression=zipfile.ZIP_STORED):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression) as archive:
        for name, data in files:
            archive.writestr(name, data)
    return output.getvalue()


class DeliveryStructureTests(unittest.TestCase):
    def test_delivery_display_title_normalizes_controls_without_changing_manifest_data(self):
        self.assertEqual(svc.display_title("  周报\r\n\t\x00版本  "), "周报 版本")
        self.assertEqual(svc.display_title("\x1f\x7f"), "本轮成果")
        long_title = "报告" * 200
        self.assertEqual(len(svc.display_title(long_title)), 240)
        self.assertEqual(svc.display_title("你好🙂"), "你好🙂")

    def test_utf16_probe_boundary_does_not_reject_a_split_surrogate_pair(self):
        text = "<html>" + "x" * 32760 + "\U0001f600" + "</html>"
        for encoding, marker in (("utf-16-le", codecs.BOM_UTF16_LE),
                                 ("utf-16-be", codecs.BOM_UTF16_BE)):
            with self.subTest(encoding=encoding):
                result = delivery_manifest.validate_bytes("report.html", marker + text.encode(encoding))
                self.assertEqual(result["state"], "passed", result)

    def test_utf16_bom_does_not_make_malformed_or_non_html_bytes_valid(self):
        for data in (codecs.BOM_UTF16_LE + b"<html>",
                     codecs.BOM_UTF16_BE + b"\xd8\x00",
                     codecs.BOM_UTF16_LE + "plain text".encode("utf-16-le"),
                     b"\x00\x01opaque binary content"):
            with self.subTest(data=data):
                result = delivery_manifest.validate_bytes("report.html", data)
                self.assertEqual(result["state"], "failed", result)
                self.assertTrue(result["reason"])


class DeliveryCollectionsTestCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-deliveries-")
        self.root = Path(self.temp.name)
        # Clone schema only; every case retains its own file-backed database,
        # transactions, concurrent connections, storage files, and HTTP routes.
        shutil.copyfile(_schema_template(), self.root / "test.sqlite")
        self.engine = create_async_engine("sqlite+aiosqlite:///" + (self.root / "test.sqlite").as_posix())
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.app = FastAPI()
        self.app.include_router(deliveries.router)
        self.app.include_router(library.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def client_override(request: Request):
            return Client(id=request.headers.get("X-Device", "desktop"),
                          user_ref=request.headers.get("X-User", "alice") or None)

        self.app.dependency_overrides[get_session] = session_override
        self.app.dependency_overrides[current_client] = client_override
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.patches = [patch.object(library_storage, "_local_root", return_value=self.root / "library"),
                        patch.object(library_storage, "storage_backend", return_value="local"),
                        patch.object(storage, "backend_name", return_value="local"),
                        patch.object(storage, "_local_path", side_effect=lambda key: str(self.root / "attachments" / key))]
        for item in self.patches:
            item.start()

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()
        for item in reversed(self.patches):
            item.stop()
        for attempt in range(20):
            try:
                self.temp.cleanup()
                break
            except PermissionError:
                if attempt == 19:
                    raise
                await asyncio.sleep(.1)

    def manifest(self, files=None, **changes):
        return {"source": "local", "sessionId": "session-one", "revision": "rev-one",
                "title": "本周交付", "entryPath": "report.md", "kind": "file",
                "files": files or [entry("report.md", b"# Weekly report")], **changes}

    async def upload(self, manifest=None, data=b"# Weekly report", **kwargs):
        return await self.http.post("/api/v1/deliveries", data={"manifest": json.dumps(manifest or self.manifest())},
            files={"file": ("payload.bin", data, "application/octet-stream")}, **kwargs)

class DeliveryCollectionsTests(DeliveryCollectionsTestCase):
    async def test_utf16_html_is_saved_and_downloaded_without_changing_original_bytes(self):
        text = '<!doctype html><html><body><h1>工作汇报</h1></body></html>'
        for encoding, marker in (("utf-16-le", codecs.BOM_UTF16_LE),
                                 ("utf-16-be", codecs.BOM_UTF16_BE)):
            with self.subTest(encoding=encoding):
                data = marker + text.encode(encoding)
                manifest = self.manifest(files=[entry("report.html", data, mime="text/html")],
                                         entryPath="report.html", revision=encoding)
                made = await self.upload(manifest, data)
                self.assertEqual(made.status_code, 200, made.text)
                delivery_id = made.json()["delivery"]["id"]
                download = await self.http.get(f"/api/v1/deliveries/{delivery_id}/download")
                self.assertEqual(download.content, data)

    async def test_invalid_html_keeps_structure_reason_and_does_not_save_a_delivery(self):
        data = b"private non-HTML content"
        manifest = self.manifest(files=[entry("report.html", data, mime="text/html")],
                                 entryPath="report.html")
        rejected = await self.upload(manifest, data)
        self.assertEqual(rejected.status_code, 422, rejected.text)
        self.assertIn("report.html", rejected.json()["detail"])
        self.assertIn("HTML 缺少可识别的页面结构", rejected.json()["detail"])
        self.assertNotIn(data.decode(), rejected.text)
        self.assertEqual((await self.http.get("/api/v1/deliveries")).json()["items"], [])

    async def test_single_original_cross_device_and_owner_isolation(self):
        made = await self.upload()
        self.assertEqual(made.status_code, 200, made.text)
        info = made.json()["delivery"]
        self.assertEqual(info["filename"], "report.md")
        self.assertEqual(info["kind"], "file")
        self.assertEqual(info["fileCount"], 1)
        self.assertNotIn("storage_key", made.text)
        for headers in ({}, {"X-Device": "phone"}, {"X-Device": "other-desktop"}):
            listing = await self.http.get("/api/v1/deliveries", headers=headers)
            self.assertEqual([row["id"] for row in listing.json()["items"]], [info["id"]])
            for suffix in ("/download", "/files/report.md"):
                response = await self.http.get("/api/v1/deliveries/" + info["id"] + suffix, headers=headers)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.content, b"# Weekly report")
                self.assertIn("attachment;", response.headers["content-disposition"])
                self.assertIn("sandbox", response.headers["content-security-policy"])
        other = {"X-User": "bob", "X-Device": "other"}
        self.assertEqual((await self.http.get("/api/v1/deliveries", headers=other)).json()["items"], [])
        for suffix in ("", "/download", "/files/report.md"):
            self.assertEqual((await self.http.get("/api/v1/deliveries/" + info["id"] + suffix, headers=other)).status_code, 404)
        same_device_different_user = await self.http.get("/api/v1/deliveries/" + info["id"], headers={"X-User": "bob"})
        self.assertEqual(same_device_different_user.status_code, 404)
        library_rows = (await self.http.get("/api/v1/library?scope=all")).json()["items"]
        self.assertEqual(library_rows[0]["id"], info["id"])
        self.assertEqual(library_rows[0]["extra"]["soduWorkDelivery"]["files"], info["files"])

    async def test_bundle_keeps_relative_structure_and_single_file_download(self):
        files = [("index.html", b"<html><link href='assets/style.css'></html>"),
                 ("assets/style.css", b"body { color: red; }"), ("docs/readme.md", b"Instructions")]
        manifest = self.manifest(files=[entry(n, d, "primary" if n == "index.html" else "supporting",
                                              "text/html" if n == "index.html" else "text/plain") for n, d in files],
                                 kind="bundle", entryPath="index.html")
        raw = archive_bytes(files)
        made = await self.upload(manifest, raw)
        self.assertEqual(made.status_code, 200, made.text)
        delivery_id = made.json()["delivery"]["id"]
        output = await self.http.get(f"/api/v1/deliveries/{delivery_id}/download")
        self.assertEqual(output.content, raw)
        with zipfile.ZipFile(io.BytesIO(output.content)) as archive:
            self.assertEqual(archive.namelist(), [n for n, _ in files])
        member = await self.http.get(f"/api/v1/deliveries/{delivery_id}/files/assets/style.css")
        self.assertEqual(member.content, files[1][1])
        html = await self.http.get(f"/api/v1/deliveries/{delivery_id}/files/index.html?preview=true")
        self.assertIn("attachment;", html.headers["content-disposition"])
        self.assertEqual((await self.http.get(f"/api/v1/deliveries/{delivery_id}/files/missing.txt")).status_code, 404)

    async def test_retry_same_account_other_device_and_conflicting_bytes(self):
        first = await self.upload()
        repeated = await self.upload(headers={"X-Device": "phone"})
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertTrue(repeated.json()["duplicate"])
        self.assertEqual(first.json()["delivery"]["id"], repeated.json()["delivery"]["id"])
        changed = b"Different bytes"
        conflict = await self.upload(self.manifest(files=[entry("report.md", changed)]), changed)
        self.assertEqual(conflict.status_code, 409, conflict.text)
        next_version = await self.upload(self.manifest(files=[entry("report.md", changed)], revision="rev-two"), changed)
        self.assertEqual(next_version.status_code, 200)
        self.assertNotEqual(first.json()["delivery"]["id"], next_version.json()["delivery"]["id"])
        self.assertEqual(len((await self.http.get("/api/v1/deliveries?sessionId=session-one")).json()["items"]), 2)
        self.assertEqual((await self.http.get("/api/v1/deliveries?source=cloud")).json()["items"], [])
        query = "/api/v1/deliveries?sessionId=session-one&source=local&revision=rev-one&limit=1"
        restored = (await self.http.get(query)).json()["items"]
        self.assertEqual([row["id"] for row in restored], [first.json()["delivery"]["id"]])
        self.assertEqual((await self.http.get(query.replace("rev-one", "missing"))).json()["items"], [])
        self.assertEqual((await self.http.get(query, headers={"X-User": "bob"})).json()["items"], [])
        self.assertEqual(len((await self.http.get("/api/v1/deliveries")).json()["items"]), 2)


    async def test_concurrent_publish_creates_one_object_and_commit_ack_loss_is_recoverable(self):
        replies = await asyncio.gather(self.upload(), self.upload(headers={"X-Device": "phone"}))
        self.assertEqual([reply.status_code for reply in replies], [200, 200], [reply.text for reply in replies])
        self.assertEqual(replies[0].json()["delivery"]["id"], replies[1].json()["delivery"]["id"])
        self.assertEqual(len([path for path in (self.root / "library").rglob("*") if path.is_file()]), 1)
        from sqlalchemy.ext.asyncio import AsyncSession
        original_commit = AsyncSession.commit
        lost = False

        async def lost_ack(session):
            nonlocal lost
            await original_commit(session)
            if not lost:
                lost = True
                raise OSError("commit acknowledgement lost")

        with patch.object(AsyncSession, "commit", lost_ack):
            accepted = await self.upload(self.manifest(revision="after-lost-ack"))
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertTrue(accepted.json()["duplicate"])
        delivery_id = accepted.json()["delivery"]["id"]
        self.assertEqual((await self.http.get(f"/api/v1/deliveries/{delivery_id}/download")).content, b"# Weekly report")

    async def test_failed_object_write_is_cleaned_and_external_dependencies_are_preserved(self):
        original_put = library_storage.put_bytes

        def partial_write(*args, **kwargs):
            original_put(*args, **kwargs)
            raise library_storage.LibraryStorageError()

        with patch.object(library_storage, "put_bytes", partial_write):
            failed = await self.upload()
        self.assertEqual(failed.status_code, 503, failed.text)
        self.assertEqual([path for path in (self.root / "library").rglob("*") if path.is_file()], [])
        manifest = self.manifest(externalDependencies=["https://fonts.example/font.css"])
        accepted = await self.upload(manifest)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(accepted.json()["delivery"]["externalDependencies"], manifest["externalDependencies"])
        changed = await self.upload(self.manifest(externalDependencies=["Other external dependency"]))
        self.assertEqual(changed.status_code, 409, changed.text)

    async def test_rejects_manifest_hash_missing_extra_unsafe_duplicate_and_symlink(self):
        invalid = []
        invalid.append((self.manifest(), b"wrong bytes"))
        invalid.append((self.manifest(entryPath="missing.md"), b"# Weekly report"))
        invalid.append((self.manifest(source=["local"]), b"# Weekly report"))
        invalid.append((self.manifest(kind={"value": "file"}), b"# Weekly report"))
        for name in ("../escape.md", "/absolute.md", "C:/private.md", "a\\b.md", "a/../b.md", "NUL.txt", "a./b.md"):
            invalid.append((self.manifest(files=[entry(name, b"x")], entryPath=name), b"x"))
        invalid.append((self.manifest(files=[entry("same.txt", b"x"), entry("SAME.txt", b"x")],
                                      kind="bundle", entryPath="same.txt"), archive_bytes([("same.txt", b"x"), ("SAME.txt", b"x")])))
        invalid.append((self.manifest(files=[entry("a", b"x"), entry("a/b.txt", b"x")], kind="bundle", entryPath="a"),
                        archive_bytes([("a", b"x"), ("a/b.txt", b"x")])))
        bundle = self.manifest(files=[entry("one.txt", b"one"), entry("two.txt", b"two")], kind="bundle", entryPath="one.txt")
        invalid.extend([(bundle, archive_bytes([("one.txt", b"one")])),
                        (bundle, archive_bytes([("one.txt", b"one"), ("two.txt", b"two"), ("secret.txt", b"unexpected")])),
                        (bundle, archive_bytes([("one.txt", b"one"), ("two.txt", b"bad")])),
                        (bundle, b"broken zip")])
        link = zipfile.ZipInfo("one.txt")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        invalid.append((bundle, archive_bytes([(link, b"one"), ("two.txt", b"two")])))
        for manifest, raw in invalid:
            with self.subTest(manifest=manifest, size=len(raw)):
                response = await self.upload(manifest, raw)
                self.assertIn(response.status_code, (400, 413, 422), response.text)
        self.assertEqual((await self.http.get("/api/v1/deliveries")).json()["items"], [])

    async def test_rejects_zip_bomb_and_upload_limits(self):
        data = b"0" * (9 * 1024 * 1024)
        manifest = self.manifest(files=[entry("large.txt", data)], kind="bundle", entryPath="large.txt")
        response = await self.upload(manifest, archive_bytes([("large.txt", data)], compression=zipfile.ZIP_DEFLATED))
        self.assertEqual(response.status_code, 413, response.text)
        with patch.object(svc, "MAX_BYTES", 8):
            self.assertEqual((await self.upload()).status_code, 413)
        with patch.object(svc, "MAX_FILES", 1):
            manifest = self.manifest(files=[entry("one", b"1"), entry("two", b"2")], kind="bundle", entryPath="one")
            self.assertEqual((await self.upload(manifest, archive_bytes([("one", b"1"), ("two", b"2")]))).status_code, 400)

    async def test_corruption_is_explicit_and_library_cannot_rewrite_final_version(self):
        made = await self.upload()
        delivery_id = made.json()["delivery"]["id"]
        for body in ({"extra": {"soduWorkDelivery": {}}}, {"extra": {}}, {"content": "overwrite"}):
            reply = await self.http.patch(f"/api/v1/library/items/{delivery_id}", json=body)
            self.assertIn(reply.status_code, (400, 409), reply.text)
        self.assertEqual((await self.http.patch(f"/api/v1/library/items/{delivery_id}", json={"title": "Renamed", "favorite": True})).status_code, 200)
        async with self.sessions() as session:
            row = await session.get(LibraryItem, delivery_id)
            library_storage.put_bytes(row.storage_key, b"damaged", row.content_type, backend=row.backend)
        self.assertEqual((await self.http.get(f"/api/v1/deliveries/{delivery_id}/download")).status_code, 502)
        self.assertEqual((await self.http.get(f"/api/v1/library/items/{delivery_id}/download")).status_code, 502)
        self.assertEqual((await self.http.delete(f"/api/v1/library/items/{delivery_id}")).status_code, 200)
        self.assertEqual((await self.http.get(f"/api/v1/deliveries/{delivery_id}")).status_code, 404)
        self.assertEqual((await self.upload()).status_code, 409)

    async def seed_cloud(self, files, *, round_no=1, state="done"):
        async with self.sessions() as session:
            # Task ownership is frozen from the persisted device/account binding.
            session.add(Client(id="desktop", user_ref="alice"))
            await session.flush()
            task = Task(id="cloud-task", owner_client_id="desktop", created_by="alice", title="Cloud report", origin="cloud-conversation")
            handoff = ConversationHandoff(id="handoff", owner_client_id="desktop", owner_user_id="alice",
                transfer_id="request-one", task_id=task.id, phase="committed",
                source={"entryKind": "cloud", "sessionId": "cloud-session"}, options={}, receipt={"ref": "runner-ref"})
            execution = ExecutionSession(id="execution", task_id=task.id, ref="runner-ref", state=state,
                metadata_={"round": round_no, "terminalSettlement": {"round": round_no, "state": "done"}})
            session.add_all([task, handoff, execution])
            for index, (name, data, role) in enumerate(files):
                key = "test/" + str(index)
                (self.root / "attachments" / "test").mkdir(parents=True, exist_ok=True)
                backend = storage.put(key, data, "text/plain")
                session.add(Attachment(id="a" + str(index), task_id=task.id, source_ref=execution.ref,
                    filename=name, content_type="text/plain", size=len(data), storage_key=key, backend=backend,
                    uploaded_by="agent:runner", role=role,
                    evidence_meta={"round": round_no, "verification": {"state": "passed"}}))
            await session.commit()
            self.assertEqual(task.owner_user_id, "alice")

    async def test_cloud_explicit_save_and_mobile_retry_without_original_device(self):
        await self.seed_cloud([("report.md", b"# Cloud result", "output"),
                               ("input.txt", b"private input", "input"), ("test-report.txt", b"evidence", "verification")])
        from app.services import execution_settlement
        async with self.sessions() as session:
            await execution_settlement.settle_terminal(session, "cloud-task", "runner-ref", include_task=False)
        status = await self.http.get("/api/v1/deliveries/from-task/cloud-task")
        self.assertIsNone(status.json()["delivery"])
        self.assertEqual((status.json()["round"], status.json()["executionRef"]), (1, "runner-ref"))
        self.assertEqual((await self.http.get("/api/v1/deliveries")).json()["items"], [])
        result = (await self.http.post("/api/v1/deliveries/from-task/cloud-task")).json()
        self.assertEqual(result["state"], "synced", result)
        self.assertEqual((result["round"], result["executionRef"]), (1, "runner-ref"))
        info = result["delivery"]
        self.assertEqual([row["path"] for row in info["files"]], ["report.md"])
        self.assertEqual(info["source"], "cloud")
        phone = {"X-Device": "phone"}
        for method in ("GET", "POST"):
            reply = await self.http.request(method, "/api/v1/deliveries/from-task/cloud-task", headers=phone)
            self.assertEqual(reply.status_code, 200, reply.text)
            self.assertEqual(reply.json()["delivery"]["id"], info["id"])
            self.assertEqual((reply.json()["round"], reply.json()["executionRef"]), (1, "runner-ref"))
        denied = await self.http.post("/api/v1/deliveries/from-task/cloud-task", headers={"X-User": "bob"})
        self.assertEqual(denied.status_code, 404)
        self.assertEqual((await self.http.get(f'/api/v1/deliveries/{info["id"]}/download', headers=phone)).content, b"# Cloud result")
        self.assertEqual(len((await self.http.get("/api/v1/deliveries?source=cloud")).json()["items"]), 1)
        # Library deletion must not touch the task's original evidence object.
        await self.http.delete(f'/api/v1/library/items/{info["id"]}')
        purge = await self.http.delete(f'/api/v1/library/items/{info["id"]}/purge')
        self.assertEqual(purge.status_code, 200, purge.text)
        async with self.sessions() as session:
            row = await session.get(Attachment, "a0")
            self.assertEqual(storage.get(row.storage_key, row.backend), b"# Cloud result")

    async def test_personal_requirement_collects_existing_files_without_cloud_handoff(self):
        await self.seed_cloud([("result.txt", b"PERSONAL_PC_REQUIREMENT_OK", "output")])
        async with self.sessions() as session:
            await session.delete(await session.get(ConversationHandoff, "handoff"))
            task = await session.get(Task, "cloud-task")
            task.origin = "local"
            task.kind = "requirement"
            task.work_routing = {"executionContext": {"runner": {
                "mode": "remote", "runnerId": "own-pc", "clientId": "desktop"}}}
            await session.commit()
        phone = {"X-Device": "phone"}
        made = await self.http.post("/api/v1/deliveries/from-task/cloud-task", headers=phone)
        self.assertEqual(made.status_code, 200, made.text)
        self.assertEqual(made.json()["state"], "synced", made.text)
        info = made.json()["delivery"]
        self.assertEqual(info["source"], "local")
        repeated = await self.http.post("/api/v1/deliveries/from-task/cloud-task", headers=phone)
        self.assertEqual(repeated.json()["delivery"]["id"], info["id"])
        download = await self.http.get(f'/api/v1/deliveries/{info["id"]}/download', headers=phone)
        self.assertEqual(download.content, b"PERSONAL_PC_REQUIREMENT_OK")
        denied = await self.http.get("/api/v1/deliveries/from-task/cloud-task", headers={"X-User": "bob"})
        self.assertEqual(denied.status_code, 404)
        async with self.sessions() as session:
            self.assertEqual((await session.get(ExecutionSession, "execution")).state, "done")
            self.assertIsNone(await session.get(ConversationHandoff, "handoff"))

    async def test_cloud_failure_retries_and_no_partial_success(self):
        await self.seed_cloud([("index.html", b"<html>result</html>", "output"),
                               ("assets/style.css", b"body{}", "output")])
        with patch.object(library_storage, "put_bytes", side_effect=library_storage.LibraryStorageError()):
            async with self.sessions() as session:
                result = await cloud_deliveries.archive_task(session, "cloud-task")
                self.assertEqual(result["state"], "failed")
                self.assertEqual((await session.get(ExecutionSession, "execution")).state, "done")
        failed = await self.http.get("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(failed.json()["state"], "failed", failed.text)
        self.assertTrue(failed.json()["retryable"])
        retry = await self.http.post("/api/v1/deliveries/from-task/cloud-task", headers={"X-Device": "phone"})
        self.assertEqual(retry.json()["state"], "synced", retry.text)
        self.assertEqual(retry.json()["delivery"]["fileCount"], 2)
        async with self.sessions() as session:
            row = await session.get(ExecutionSession, "execution")
            row.metadata_ = {**row.metadata_, "round": 2,
                "terminalSettlement": {"round": 2, "state": "incomplete", "missing": ["report.md"]}}
            await session.commit()
        missing = await self.http.post("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(missing.json()["state"], "failed", missing.text)
        self.assertIn("未收齐", missing.json()["error"])

    async def test_cloud_existing_bundle_is_not_double_zipped_and_old_rounds_do_not_mix(self):
        files = [("site/index.html", b"<html><link href='assets/style.css'><link href='https://cdn.example/theme.css'></html>"),
                 ("site/assets/style.css", b"body{}")]
        data = archive_bytes(files)
        await self.seed_cloud([("完整产出-site.zip", data, "output"),
                               (files[0][0], files[0][1], "output")])
        response = await self.http.post("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(response.json()["state"], "synced", response.text)
        info = response.json()["delivery"]
        self.assertEqual(info["entryPath"], "site/index.html")
        self.assertEqual(info["fileCount"], 2)
        self.assertEqual(info["externalDependencies"], ["https://cdn.example/theme.css"])
        self.assertEqual((await self.http.get(f'/api/v1/deliveries/{info["id"]}/download', headers={"X-Device": "phone"})).content, data)
        async with self.sessions() as session:
            row = await session.get(ExecutionSession, "execution")
            row.metadata_ = {**row.metadata_, "round": 2, "terminalSettlement": {"round": 2, "state": "done"}}
            await session.commit()
        stale = await self.http.post("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(stale.json()["state"], "failed", stale.text)
        self.assertIn("本轮", stale.json()["error"])
        self.assertEqual(len((await self.http.get("/api/v1/deliveries")).json()["items"]), 1)

    async def test_cloud_merges_bundle_and_outside_report_without_duplicate_members(self):
        website = [("site/index.html", b"<html><link href='assets/style.css'></html>"),
                   ("site/assets/style.css", b"body{color:#333}")]
        report = b"# Final report\nThe website and report are delivered together."
        await self.seed_cloud([("完整产出-site.zip", archive_bytes(website), "output"),
                               ("report.md", report, "output"),
                               (website[1][0], website[1][1], "output"),
                               ("private-input.txt", b"not a delivery", "input")])
        response = await self.http.post("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(response.json()["state"], "synced", response.text)
        info = response.json()["delivery"]
        expected = dict(website + [("report.md", report)])
        self.assertEqual(info["entryPath"], "site/index.html")
        self.assertEqual({row["path"] for row in info["files"]}, set(expected))
        download = await self.http.get(f'/api/v1/deliveries/{info["id"]}/download', headers={"X-Device": "phone"})
        with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
            self.assertEqual(len(archive.infolist()), 3)
            self.assertEqual({name: archive.read(name) for name in archive.namelist()}, expected)
        repeated = await self.http.post("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(repeated.json()["delivery"]["id"], info["id"])

    async def test_cloud_bundle_conflict_fails_instead_of_overwriting_or_dropping_report(self):
        await self.seed_cloud([("完整产出-site.zip", archive_bytes([("site/index.html", b"<html>old</html>")]), "output"),
                               ("site/index.html", b"<html>new</html>", "output"),
                               ("report.md", b"# Final report", "output")])
        response = await self.http.post("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(response.json()["state"], "failed", response.text)
        self.assertIn("路径冲突", response.json()["error"])
        self.assertTrue(response.json()["retryable"])
        self.assertEqual((await self.http.get("/api/v1/deliveries")).json()["items"], [])
        async with self.sessions() as session:
            self.assertEqual((await session.get(ExecutionSession, "execution")).state, "done")

    async def test_cloud_source_bundle_links_cannot_be_laundered_by_merging_report(self):
        link = zipfile.ZipInfo("assets/theme.css")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        await self.seed_cloud([("完整产出-site.zip", archive_bytes([
            ("index.html", b"<html>result</html>"), (link, b"outside.css")]), "output"),
            ("report.md", b"# Final report", "output")])
        response = await self.http.post("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(response.json()["state"], "failed", response.text)
        self.assertIn("链接", response.json()["error"])
        self.assertEqual((await self.http.get("/api/v1/deliveries")).json()["items"], [])

    async def test_cloud_requires_completed_ingestion_and_never_promotes_failed_partial_files(self):
        await self.seed_cloud([("report.md", b"partial report", "output")], state="failed")
        rejected = await self.http.post("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(rejected.json()["state"], "incomplete", rejected.text)
        self.assertFalse(rejected.json()["retryable"])
        async with self.sessions() as session:
            row = await session.get(ExecutionSession, "execution")
            # An explicit in-progress collection differs from a lost marker
            # after restart, which the production retry path can reconstruct.
            row.state, row.metadata_ = "done", {"round": 1,
                "terminalSettlement": {"round": 1, "state": "pending"}}
            await session.commit()
        pending = await self.http.post("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(pending.json()["state"], "pending", pending.text)
        self.assertEqual((await self.http.get("/api/v1/deliveries")).json()["items"], [])

    async def test_cloud_retry_recovers_a_lost_settlement_from_verified_current_files(self):
        await self.seed_cloud([("report.md", b"verified complete report", "output")])
        async with self.sessions() as session:
            row = await session.get(ExecutionSession, "execution")
            row.metadata_ = {"round": 1}
            await session.commit()
        result = (await self.http.post("/api/v1/deliveries/from-task/cloud-task")).json()
        self.assertEqual(result["state"], "synced", result)
        self.assertEqual((result["round"], result["executionRef"]), (1, "runner-ref"))
        self.assertEqual((await self.http.get(f'/api/v1/deliveries/{result["delivery"]["id"]}/download')).content,
                         b"verified complete report")
        repeated = (await self.http.post("/api/v1/deliveries/from-task/cloud-task")).json()
        self.assertEqual(repeated["delivery"]["id"], result["delivery"]["id"])

    async def test_cloud_late_sync_does_not_clobber_a_new_execution_round(self):
        await self.seed_cloud([("report.md", b"# Cloud result", "output")])
        original_persist = svc.persist

        async def resume_during_store(*args, **kwargs):
            result = await original_persist(*args, **kwargs)
            async with self.sessions() as other:
                row = await other.get(ExecutionSession, "execution")
                row.state = "running"
                row.metadata_ = {**row.metadata_, "round": 2, "keepMe": "current runtime state"}
                await other.commit()
            return result

        with patch.object(svc, "persist", resume_during_store):
            response = await self.http.post("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["state"], "pending", response.text)
        self.assertIsNone(response.json()["delivery"])
        self.assertEqual((response.json()["round"], response.json()["executionRef"]), (2, "runner-ref"))
        async with self.sessions() as session:
            row = await session.get(ExecutionSession, "execution")
            self.assertEqual(row.state, "running")
            self.assertEqual(row.metadata_["round"], 2)
            self.assertEqual(row.metadata_["keepMe"], "current runtime state")
            self.assertNotIn("deliverySync", row.metadata_)

    async def test_historical_receipt_remains_immutable_after_current_task_advances(self):
        await self.seed_cloud([("report.md", b"old report", "output")])
        first = (await self.http.post("/api/v1/deliveries/from-task/cloud-task")).json()
        async with self.sessions() as session:
            row = await session.get(ExecutionSession, "execution")
            row.metadata_ = {**row.metadata_, "round": 2, "terminalSettlement": {"round": 2, "state": "done"}}
            backend = storage.put("test/new-report", b"new report", "text/plain")
            session.add(Attachment(id="new-report", task_id="cloud-task", source_ref="runner-ref",
                filename="report.md", content_type="text/plain", size=10, storage_key="test/new-report", backend=backend,
                uploaded_by="agent:runner", role="output", evidence_meta={"round": 2, "verification": {"state": "passed"}}))
            await session.commit()
        current = (await self.http.post("/api/v1/deliveries/from-task/cloud-task")).json()
        self.assertEqual((current["round"], current["executionRef"]), (2, "runner-ref"))
        self.assertNotEqual(current["delivery"]["id"], first["delivery"]["id"])
        restored = (await self.http.get(f'/api/v1/deliveries/{first["delivery"]["id"]}')).json()
        self.assertEqual(restored["delivery"]["revision"], first["delivery"]["revision"])
        self.assertEqual((await self.http.get(f'/api/v1/deliveries/{first["delivery"]["id"]}/download')).content, b"old report")
        denied = await self.http.get(f'/api/v1/deliveries/{first["delivery"]["id"]}', headers={"X-User": "bob"})
        self.assertEqual(denied.status_code, 404)

    async def test_postcommit_turn_advance_does_not_relabel_a_persisted_receipt(self):
        from sqlalchemy.ext.asyncio import AsyncSession
        await self.seed_cloud([("report.md", b"old report", "output")])
        original_refresh = AsyncSession.refresh
        advanced = False

        async def advance_before_refresh(session, instance, *args, **kwargs):
            nonlocal advanced
            if isinstance(instance, ExecutionSession) and not advanced:
                advanced = True
                async with self.sessions() as other:
                    row = await other.get(ExecutionSession, "execution")
                    self.assertEqual(row.metadata_["deliverySync"]["round"], 1)
                    row.state = "running"
                    row.metadata_ = {**row.metadata_, "round": 2}
                    await other.commit()
            return await original_refresh(session, instance, *args, **kwargs)

        with patch.object(AsyncSession, "refresh", advance_before_refresh):
            response = await self.http.post("/api/v1/deliveries/from-task/cloud-task")
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertTrue(advanced)
        self.assertEqual(result["state"], "synced")
        self.assertEqual((result["round"], result["executionRef"]), (1, "runner-ref"))
        self.assertEqual((await self.http.get(f'/api/v1/deliveries/{result["delivery"]["id"]}/download')).content, b"old report")
        current = (await self.http.get("/api/v1/deliveries/from-task/cloud-task")).json()
        self.assertEqual((current["state"], current["round"]), ("running", 2))
        self.assertIsNone(current["delivery"])

    async def test_unbound_devices_stay_private(self):
        made = await self.upload(headers={"X-User": "", "X-Device": "guest-one"})
        self.assertEqual(made.status_code, 200, made.text)
        delivery_id = made.json()["delivery"]["id"]
        reply = await self.http.get("/api/v1/deliveries/" + delivery_id,
                                    headers={"X-User": "", "X-Device": "guest-two"})
        self.assertEqual(reply.status_code, 404)

    async def test_real_device_tokens_over_tcp_download_after_connection_restart(self):
        """A second installation authenticates independently and downloads real bytes."""
        import uvicorn
        from app.models import AppSetting, User
        from app.services import client_access, device_auth
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda conn: Base.metadata.create_all(conn, tables=[
                User.__table__, Client.__table__, AppSetting.__table__]))
        async with self.sessions() as session:
            desktop = Client(id="real-desktop", user_ref="alice", auth_state="active")
            phone = Client(id="real-phone", user_ref="alice", auth_state="active")
            other = Client(id="real-other", user_ref="bob", auth_state="active")
            session.add_all([User(id="alice", username="alice", is_active=True),
                             User(id="bob", username="bob", is_active=True), desktop, phone, other])
            await session.commit()
        tokens = {name: "Device " + device_auth.issue_session(client)[0]
                  for name, client in (("desktop", desktop), ("phone", phone), ("other", other))}
        self.app.dependency_overrides.pop(current_client)
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(16)
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(self.app, log_level="critical", lifespan="off"))
        run = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(.01)
            self.assertTrue(server.started)
            files = [("index.html", b"<html>Cross-device delivery</html>"), ("assets/style.css", b"body{}")]
            package = archive_bytes(files)
            manifest = self.manifest(files=[entry(n, data, "primary" if n == "index.html" else "supporting") for n, data in files],
                                     kind="bundle", entryPath="index.html")
            with patch.object(client_access, "_policy_cache", None):
                async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", trust_env=False) as desktop_http:
                    upload = await desktop_http.post("/api/v1/deliveries",
                        headers={"Authorization": tokens["desktop"]}, data={"manifest": json.dumps(manifest)},
                        files={"file": ("delivery.zip", package, "application/zip")})
                    self.assertEqual(upload.status_code, 200, upload.text)
                    delivery_id = upload.json()["delivery"]["id"]
                await self.engine.dispose()
                async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", trust_env=False) as phone_http:
                    listed = await phone_http.get("/api/v1/deliveries", headers={"Authorization": tokens["phone"]})
                    self.assertEqual(listed.status_code, 200, listed.text)
                    self.assertEqual(listed.json()["items"][0]["id"], delivery_id)
                    download = await phone_http.get(f"/api/v1/deliveries/{delivery_id}/download",
                        headers={"Authorization": tokens["phone"]})
                    self.assertEqual(download.status_code, 200, download.text)
                    self.assertEqual(download.content, package)
                    with zipfile.ZipFile(io.BytesIO(download.content)) as archive:
                        self.assertEqual(archive.read("assets/style.css"), b"body{}")
                    denied = await phone_http.get(f"/api/v1/deliveries/{delivery_id}/download",
                        headers={"Authorization": tokens["other"]})
                    self.assertEqual(denied.status_code, 404)
                    missing_auth = await phone_http.get(f"/api/v1/deliveries/{delivery_id}/download")
                    self.assertEqual(missing_auth.status_code, 401)
                    async with self.sessions() as session:
                        row = await session.get(Client, phone.id)
                        row.auth_version += 1
                        await session.commit()
                    revoked = await phone_http.get(f"/api/v1/deliveries/{delivery_id}/download",
                        headers={"Authorization": tokens["phone"]})
                    self.assertEqual(revoked.status_code, 401)
        finally:
            server.should_exit = True
            await asyncio.wait_for(run, 5)
            listener.close()


if __name__ == "__main__":
    unittest.main()
