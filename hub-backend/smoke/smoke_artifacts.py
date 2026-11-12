# -*- coding: utf-8 -*-
"""Artifact collection, relative paths and complete archive contents."""
import asyncio
import io
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import zipfile

sys.path.insert(0, ".")
_DATA = tempfile.TemporaryDirectory(prefix="soduwork-smoke-art-data-")
DATA = _DATA.name
os.environ["SODUWORK_DATA_ROOT"] = DATA
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + Path(DATA, "smoke.db").as_posix()

from app.services import ai_local, declared_outputs, local_base  # noqa: E402

ok = fail = 0
log = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


# Preserve artifact directory paths.
chk("★★保住子目录（这就是网站打不开的根因）",
    ai_local._rel_name("css/style.css") == "css/style.css", ai_local._rel_name("css/style.css"))
chk("Windows 的反斜杠统一成 /",
    ai_local._rel_name("assets\\img\\logo.svg") == "assets/img/logo.svg")
chk("★不许路径穿越（这个名字会进 zip 条目名和对象键）",
    ".." not in ai_local._rel_name("../../etc/passwd"), ai_local._rel_name("../../etc/passwd"))
chk("不许绝对路径", not ai_local._rel_name("/etc/passwd").startswith("/"))
chk("空名字有兜底", ai_local._rel_name("") == "文件")

# Verify output limits and visible omission counts.
chk("★上限不再是 10（一个静态站三十个文件是常态）", ai_local._ART_CAP >= 100, ai_local._ART_CAP)

ws = tempfile.mkdtemp(prefix="smoke-art-")
try:
    # Create a representative website with HTML, CSS, JavaScript, assets, and duplicate basenames in separate directories.
    files = ["index.html", "about.html", "contact.html",
             "css/style.css", "js/main.js",
             "assets/logo.svg", "assets/img/hero.png",
             "css/print.css", "vendor/style.css"]          # Same basename as css/style.css in a different directory.
    for rel in files:
        p = os.path.join(ws, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        io.open(p, "w", encoding="utf-8").write("x" * 10)
    # These noise files must never count as deliverables.
    for rel in ["node_modules/pkg/index.js", ".git/config", "__pycache__/a.pyc",
                "dist/bundle.js", "target/classes/App.class", "package-lock.json"]:
        p = os.path.join(ws, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        io.open(p, "w", encoding="utf-8").write("noise")

    run = {"ref": "smoke-art", "ws": ws, "seen": set(), "state": "done",
           "cli": "pi", "lines": [], "title": "冒烟"}
    ai_local._RUNS["smoke-art"] = run
    got = ai_local._new_files(run)

    chk("★★全都收上来了（不是只收 10 个）", len(got) == len(files), (len(got), sorted(got)))
    chk("★★收上来的是**带目录的相对路径**",
        any(x.replace("\\", "/") == "css/style.css" for x in got), sorted(got))
    chk("★噪音一个都没混进来（node_modules/.git/dist/target/缓存/lock 文件）",
        not any(k in "|".join(got).replace("\\", "/")
                for k in ("node_modules", ".git/", "__pycache__", "dist/", "target/",
                          "package-lock")),
        sorted(got))
    chk("没被截断时不报截断", int(run.get("artDropped") or 0) == 0, run.get("artDropped"))

    # Report truncation explicitly.
    old_cap = ai_local._ART_CAP
    try:
        ai_local._ART_CAP = 3
        run2 = dict(run, seen=set())
        ai_local._RUNS["smoke-art"] = run2
        got2 = ai_local._new_files(run2)
        chk("上限生效", len(got2) == 3, len(got2))
        chk("★★截了几个**必须说出来**（静默截断＝人拿到残包还不知道）",
            int(run2.get("artDropped") or 0) == len(files) - 3, run2.get("artDropped"))
    finally:
        ai_local._ART_CAP = old_cap

    # status_sync filenames must preserve relative directories.
    run3 = dict(run, seen=set(), state="done")
    ai_local._RUNS["smoke-art"] = run3
    st = ai_local.status_sync({}, "smoke-art")
    names = [a["filename"] for a in st["attachments"]]
    text_run = dict(run, ref="smoke-text-result", seen=set(), state="done", lines=[
        {"kind": "say", "text": "progress"},
        {"kind": "do", "tool": "bash", "text": "echo ignored"},
        {"kind": "say", "text": "final short", "full": "final complete result"},
    ])
    ai_local._RUNS["smoke-text-result"] = text_run
    text_status = ai_local.status_sync({}, "smoke-text-result")
    chk("status exposes only the last complete assistant reply as finalText",
        text_status.get("finalText") == "final complete result", text_status.get("finalText"))
    chk("★★已结束会话向插件引擎明确返回 done", st.get("done") is True
        and st.get("running") is False, st)
    chk("★★交给上层的 filename 带目录（原来这儿 basename，一切就是从这坏的）",
        "css/style.css" in names, names)
    chk("★同名不同目录的两个文件**都在**（拍平的话它们会互相顶掉）",
        "css/style.css" in names and "vendor/style.css" in names, names)
    chk("status 里带上了被截掉几个", "artifactsDropped" in st, sorted(st.keys()))
    chk("★上下文段号与成果轮次分开返回", st.get("segment") == 1 and st.get("round") == 1, st)
    bundles = [a for a in st["attachments"] if str(a.get("id") or "").startswith("@bundle/")]
    chk("★★目录型产出自动多一份完整 zip", len(bundles) == 1, st["attachments"][:3])
    bundle_bytes = ai_local.fetch_attachment_for_sync({}, "smoke-art", bundles[0]["id"])
    with zipfile.ZipFile(io.BytesIO(bundle_bytes or b"")) as z:
        bundled_names = set(z.namelist())
    chk("★★完整 zip 内保留所有网站文件和目录", set(files) <= bundled_names, sorted(bundled_names))

    # The complete package must retain all files even when the individual list exceeds its cap.
    many = ["assets/chunk-%03d.js" % i for i in range(ai_local._ART_CAP + 25)]
    for rel in many:
        p = os.path.join(ws, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        io.open(p, "w", encoding="utf-8").write(rel)
    run4 = dict(run, seen=set(), state="done")
    ai_local._RUNS["smoke-art"] = run4
    st4 = ai_local.status_sync({}, "smoke-art")
    b4 = next(a for a in st4["attachments"] if str(a.get("id") or "").startswith("@bundle/"))
    raw4 = ai_local.fetch_attachment_for_sync({}, "smoke-art", b4["id"])
    with zipfile.ZipFile(io.BytesIO(raw4 or b"")) as z:
        names4 = set(z.namelist())
    chk("★★超过 200 个文件也只占至多 200 条附件", len(st4["attachments"]) <= ai_local._ART_CAP)
    chk("★★超过上限的网站仍在完整包里一份不缺", set(many) <= names4,
        (len(many), len(names4)))
    chk("有完整包时不再谎报文件丢失", st4.get("artifactsDropped") == 0
        and st4.get("artifactsBundled") == len(files) + len(many), st4)

    # Repository tasks deliver authoritative branches or commits, not full repository archives.
    code_run = dict(run, ref="smoke-code-art", seen=set(), state="done", codeTask=True)
    ai_local._RUNS["smoke-code-art"] = code_run
    code_status = ai_local.status_sync({}, "smoke-code-art")
    chk("★★工程任务只交 Git 凭证，不返回仓库压缩包",
        code_status.get("deliveryKind") == "code"
        and code_status.get("attachments") == []
        and code_status.get("artifactsBundled") == 0, code_status)

    # Git nodes may also declare a small control-plane output. Collect that exact
    # path without scanning or zipping the repository.
    review_rel = "code-review.json"
    review_baseline = declared_outputs.baseline(ws, [review_rel])
    review_path = os.path.join(ws, review_rel)
    io.open(review_path, "w", encoding="utf-8").write('{"verdict":"pass"}')
    review_run = dict(
        run, ref="smoke-code-review-art", seen=set(), state="done",
        codeTask=True, artifactMode="git",
        expectedOutputPaths=[review_rel],
        expectedOutputBaseline=review_baseline,
    )
    ai_local._RUNS["smoke-code-review-art"] = review_run
    review_status = ai_local.status_sync({}, "smoke-code-review-art")
    chk("★★Git 节点会精确回传声明的 Review 决策文件",
        review_status.get("attachments") == [{
            "id": review_rel, "filename": review_rel
        }] and review_status.get("artifactsBundled") == 0, review_status)

    unchanged_run = dict(
        review_run, ref="smoke-code-review-unchanged",
        expectedOutputBaseline=declared_outputs.baseline(ws, [review_rel]),
    )
    ai_local._RUNS["smoke-code-review-unchanged"] = unchanged_run
    unchanged_status = ai_local.status_sync({}, "smoke-code-review-unchanged")
    chk("运行前已存在且未改变的声明文件不会冒充本轮产出",
        unchanged_status.get("attachments") == [], unchanged_status)

    legacy_rel = "legacy-review.json"
    legacy_started = time.time() - 1
    io.open(os.path.join(ws, legacy_rel), "w", encoding="utf-8").write("{}")
    legacy_run = dict(
        run, ref="smoke-code-review-legacy", seen=set(), state="done",
        codeTask=True, artifactMode="git", started=legacy_started,
        workspaceGuard={"enabled": True, "allowedPaths": [legacy_rel]},
    )
    legacy_run.pop("expectedOutputPaths", None)
    legacy_run.pop("expectedOutputBaseline", None)
    ai_local._RUNS["smoke-code-review-legacy"] = legacy_run
    legacy_status = ai_local.status_sync({}, "smoke-code-review-legacy")
    explicit_empty = dict(
        legacy_run, expectedOutputPaths=[], expectedOutputBaseline={})
    chk("explicit empty outputs do not borrow legacy workspace-guard files",
        declared_outputs.changed_entries(explicit_empty) == [],
        declared_outputs.changed_entries(explicit_empty))
    rootless = dict(legacy_run, ws="")
    chk("missing workspace never reads files from the backend current directory",
        declared_outputs.changed_entries(rootless) == [],
        declared_outputs.changed_entries(rootless))
    chk("升级前已启动的 Runner 也能按工作区声明恢复决策文件",
        any(item.get("filename") == legacy_rel
            for item in legacy_status.get("attachments") or []), legacy_status)
    chk("声明产出拒绝绝对路径和路径穿越",
        declared_outputs.paths([
            {"kind": "file", "path": "../secret.txt"},
            {"kind": "decision", "path": "C:/secret.txt"},
        ]) == [])
    chk("声明产出元数据会随 Runner 存档并在重启后恢复",
        "expectedOutputPaths" in local_base._PERSIST_KEYS
        and "expectedOutputBaseline" in local_base._PERSIST_KEYS,
        local_base._PERSIST_KEYS)

    repo_file_run = dict(run, ref="smoke-repo-file-art", seen=set(), state="done",
                         codeTask=True, artifactMode="files")
    ai_local._RUNS["smoke-repo-file-art"] = repo_file_run
    repo_file_status = ai_local.status_sync({}, "smoke-repo-file-art")
    chk("★★工程任务里的文件型节点仍完整回传需求等过程产出",
        repo_file_status.get("deliveryKind") == "files"
        and bool(repo_file_status.get("attachments")), repo_file_status)

    running = dict(run, seen=set(), state="running")
    ai_local._RUNS["smoke-art"] = running
    live = ai_local.status_sync({}, "smoke-art")
    chk("运行中会话不会提前向插件引擎报完成", live.get("done") is False
        and live.get("running") is True and live.get("attachments") == [], live)

    # Verify extracted ZIP directory structure.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            z.writestr(n, b"x" * 10)
    buf.seek(0)
    out = tempfile.mkdtemp(prefix="smoke-unzip-")
    try:
        with zipfile.ZipFile(buf) as z:
            z.extractall(out)
        chk("★★解压之后 css/style.css 真的在 css/ 底下（这就是用户要的「能正常运行」）",
            os.path.isfile(os.path.join(out, "css", "style.css")),
            os.listdir(out))
        chk("★assets 的多层目录也对", os.path.isfile(os.path.join(out, "assets", "img", "hero.png")))
        chk("★同名的两个都在、没互相覆盖",
            os.path.isfile(os.path.join(out, "css", "style.css"))
            and os.path.isfile(os.path.join(out, "vendor", "style.css")))
    finally:
        shutil.rmtree(out, ignore_errors=True)

    # A later round with the same ref and filenames creates a new version; downloads use the current fixed version.
    async def versioned_roundtrip():
        from fastapi import HTTPException
        from sqlalchemy import delete, select
        from app import automation_models as am, models
        from app.api.delivery import artifacts_zip
        from app.db import SessionLocal, init_db
        from app.services import artifact_ingest, delivery_manifest, storage

        cid, tid, ref = "c-smoke-art-v2", "t-smoke-art-v2", "smoke-art-v2"
        reviewer_uid, reviewer_cid = "u-smoke-art-reviewer", "c-smoke-art-reviewer"
        outsider_uid, outsider_cid = "u-smoke-art-outsider", "c-smoke-art-outsider"
        request_id = "ar-smoke-art-v2"
        await init_db()

        async def purge(session):
            request_ids = list((await session.execute(select(am.ApprovalRequest.id).where(
                am.ApprovalRequest.task_id == tid))).scalars())
            if request_ids:
                await session.execute(delete(am.ApprovalAssignment).where(
                    am.ApprovalAssignment.request_id.in_(request_ids)))
                await session.execute(delete(am.ApprovalDecision).where(
                    am.ApprovalDecision.request_id.in_(request_ids)))
            await session.execute(delete(am.ApprovalRequest).where(am.ApprovalRequest.task_id == tid))
            await session.execute(delete(am.ArtifactVersion).where(am.ArtifactVersion.task_id == tid))
            await session.execute(delete(models.Attachment).where(models.Attachment.task_id == tid))
            await session.execute(delete(models.TaskEvent).where(models.TaskEvent.task_id == tid))
            await session.execute(delete(models.Task).where(models.Task.id == tid))
            await session.execute(delete(models.Client).where(models.Client.id.in_({
                cid, reviewer_cid, outsider_cid})))
            await session.execute(delete(models.User).where(models.User.id.in_({
                reviewer_uid, outsider_uid})))
            await session.commit()

        round_ws = tempfile.mkdtemp(prefix="smoke-art-v2-")
        try:
            os.makedirs(os.path.join(round_ws, "assets"), exist_ok=True)
            io.open(os.path.join(round_ws, "index.html"), "w", encoding="utf-8").write(
                "<!doctype html><html><body>old</body></html>")
            io.open(os.path.join(round_ws, "assets", "app.js"), "w", encoding="utf-8").write(
                "window.version='old'")
            # Three final pages exercise automatic bundles under the updated contract.
            for page in ("about.html", "contact.html"):
                with open(os.path.join(round_ws, page), "w", encoding="utf-8") as stream:
                    stream.write("<!doctype html><html><body>Supporting page</body></html>")
            run_v2 = {"ref": ref, "ws": round_ws, "seen": set(), "state": "done",
                      "cli": "pi", "lines": [], "title": "返修版本",
                      "segment": 1, "round": 1, "cfg": {}}
            ai_local._RUNS[ref] = run_v2
            async with SessionLocal() as session:
                await purge(session)
                client = models.Client(id=cid, name="成果版本冒烟", secret="x")
                reviewer = models.User(
                    id=reviewer_uid, username="smoke-art-reviewer",
                    display_name="成果审批人", is_active=True)
                reviewer_client = models.Client(
                    id=reviewer_cid, name="成果审批设备", secret="x", user_ref=reviewer_uid)
                outsider = models.User(
                    id=outsider_uid, username="smoke-art-outsider",
                    display_name="无关人员", is_active=True)
                outsider_client = models.Client(
                    id=outsider_cid, name="无关设备", secret="x", user_ref=outsider_uid)
                # Delivery review is creator-owned; keep the execution device
                # separate so the evidence download still exercises a remote
                # creator approving the fixed version.
                task = models.Task(id=tid, title="同会话返修", owner_client_id=cid,
                                   created_by=reviewer_uid, status="doing")
                session.add_all([client, reviewer, reviewer_client, outsider, outsider_client,
                                 task, models.TaskEvent(
                    task_id=tid, kind="ai.dispatched",
                    detail={"ref": ref, "provider": "local", "assigneeId": "local:pi"})])
                await session.commit()
                ctx = {"name": "local", "cfg": {}, "localCfg": {}}
                first = ai_local.status_sync({}, ref)
                await artifact_ingest.pull_artifacts(session, tid, ctx, first, ref, settle=False)
                first_rows = list((await session.execute(select(models.Attachment).where(
                    models.Attachment.task_id == tid
                ).order_by(models.Attachment.created_at, models.Attachment.id))).scalars())
                first_manifest = delivery_manifest.build(first_rows, source_ref=ref)

                time.sleep(0.03)
                io.open(os.path.join(round_ws, "index.html"), "w", encoding="utf-8").write(
                    "<!doctype html><html><body>new</body></html>")
                from app.services import local_stream
                old_profile = local_stream._PROFILES["pi"]
                old_spawn = local_stream._spawn
                local_stream._PROFILES["pi"] = {
                    **old_profile, "bin": lambda: "pi", "own_session": True,
                    "resume": lambda _sid, _mode, _ws, _cfg: [],
                }
                local_stream._spawn = lambda *_args, **_kwargs: None
                try:
                    resumed = local_stream._resume(ref, "按验收意见继续修改", {})
                finally:
                    local_stream._spawn = old_spawn
                    local_stream._PROFILES["pi"] = old_profile
                run_v2["state"] = "done"
                second = ai_local.status_sync({}, ref)
                chk("★★真实续跑增加成果轮次，但不伪造上下文压缩段",
                    resumed.get("ok") is True and second.get("round") == 2
                    and second.get("segment") == 1, second)
                await artifact_ingest.pull_artifacts(session, tid, ctx, second, ref, settle=False)
                rows = list((await session.execute(select(models.Attachment).where(
                    models.Attachment.task_id == tid
                ).order_by(models.Attachment.created_at, models.Attachment.id))).scalars())
                indexes = [row for row in rows if row.filename == "index.html"]
                chk("★★同一 ref 第二轮的同名文件没有被第一轮回执吞掉",
                    len(indexes) == 2 and {
                        int((row.evidence_meta or {}).get("round") or 0) for row in indexes
                    } == {1, 2}, [(row.filename, row.evidence_meta) for row in indexes])

                manifest = delivery_manifest.build(rows, source_ref=ref)
                chk("★★固定版本只包含最新轮次，不混入返修前完整包",
                    {int(item.get("round") or 0) for item in manifest.get("files") or []} == {2},
                    manifest.get("files"))
                artifact = am.ArtifactVersion(
                    id="av-smoke-art-v2", task_id=tid, seq=2, kind="files",
                    source_ref=ref, checksum="2" * 64, manifest=manifest, state="candidate")
                request = am.ApprovalRequest(
                    id=request_id, task_id=tid, artifact_version_id=artifact.id,
                    action="review", status="pending", required_count=1,
                    policy_snapshot={"separationOfDuties": True})
                assignment = am.ApprovalAssignment(
                    request_id=request_id, user_id=reviewer_uid,
                    user_name="成果审批人", sources=[{"type": "user", "label": "指定审批人"}])
                newer_artifact = am.ArtifactVersion(
                    id="av-smoke-art-v3", task_id=tid, seq=3, kind="files",
                    source_ref=ref, checksum="3" * 64, manifest=first_manifest,
                    state="candidate")
                session.add_all([artifact, request, assignment, newer_artifact])
                await session.commit()

                async def response_bytes(value):
                    chunks = []
                    async for chunk in value.body_iterator:
                        chunks.append(bytes(chunk))
                    return b"".join(chunks)

                response = await artifacts_zip(
                    tid, artifact_version_id=artifact.id, client=client, session=session)
                with zipfile.ZipFile(io.BytesIO(await response_bytes(response))) as archive:
                    names = set(archive.namelist())
                    current = archive.read("index.html").decode("utf-8")
                chk("★★指定固定版本下载的是该版网站，不再出现 index(1).html 之类历史副本",
                    "index.html" in names and "index(1).html" not in names and "new" in current,
                    (sorted(names), current))

                latest_response = await artifacts_zip(tid, client=client, session=session)
                with zipfile.ZipFile(io.BytesIO(await response_bytes(latest_response))) as archive:
                    latest_current = archive.read("index.html").decode("utf-8")
                chk("不指定版本时任务持有人仍下载当前最新固定版本",
                    "old" in latest_current, latest_current)

                cross_version_denied = None
                try:
                    await artifacts_zip(tid, client=reviewer_client, session=session)
                except HTTPException as exc:
                    cross_version_denied = exc
                chk("★★审批 v2 的人不能借任务级入口越权下载后来产生的 v3",
                    cross_version_denied is not None and cross_version_denied.status_code == 404,
                    cross_version_denied.detail if cross_version_denied else "not denied")

                reviewer_response = await artifacts_zip(
                    tid, artifact_version_id=artifact.id,
                    client=reviewer_client, session=session)
                with zipfile.ZipFile(io.BytesIO(await response_bytes(reviewer_response))) as archive:
                    reviewer_current = archive.read("index.html").decode("utf-8")
                chk("★★被明确指派的人审可以下载当前固定成果并真正验收",
                    "new" in reviewer_current, reviewer_current)

                await session.execute(delete(am.ApprovalAssignment).where(
                    am.ApprovalAssignment.request_id == request_id))
                session.add(am.ApprovalDecision(
                    request_id=request_id, user_id=reviewer_uid,
                    user_name="成果审批人", decision="approve", note="已验收"))
                await session.commit()
                decided_response = await artifacts_zip(
                    tid, artifact_version_id=artifact.id,
                    client=reviewer_client, session=session)
                chk("★★已办审批仍能回看自己审过的不可变成果",
                    bool(await response_bytes(decided_response)))

                outsider_denied = None
                try:
                    await artifacts_zip(tid, artifact_version_id=artifact.id,
                                        client=outsider_client, session=session)
                except HTTPException as exc:
                    outsider_denied = exc
                chk("★★无关用户不能借任务编号下载成果，且不泄露任务是否存在",
                    outsider_denied is not None and outsider_denied.status_code == 404,
                    outsider_denied.detail if outsider_denied else "not denied")
                bundle_row = next(row for row in rows if row.filename.startswith("完整产出-")
                                  and int((row.evidence_meta or {}).get("round") or 0) == 2)
                old_get = storage.get

                def fail_bundle(key, backend=""):
                    if key == bundle_row.storage_key:
                        raise OSError("simulated missing bundle")
                    return old_get(key, backend)

                storage.get = fail_bundle
                atomic_failure = None
                try:
                    await artifacts_zip(tid, artifact_version_id=artifact.id,
                                        client=client, session=session)
                except HTTPException as exc:
                    atomic_failure = exc
                finally:
                    storage.get = old_get
                chk("★★当前固定版本缺文件时整包失败，不静默返回残缺网站",
                    atomic_failure is not None and atomic_failure.status_code == 502
                    and "不完整压缩包" in str(atomic_failure.detail),
                    atomic_failure.detail if atomic_failure else "no error")
                await purge(session)
        finally:
            ai_local._RUNS.pop(ref, None)
            shutil.rmtree(round_ws, ignore_errors=True)

    asyncio.run(versioned_roundtrip())
finally:
    ai_local._RUNS.pop("smoke-art", None)
    ai_local._RUNS.pop("smoke-code-art", None)
    shutil.rmtree(ws, ignore_errors=True)
    from app.db import engine
    asyncio.run(engine.dispose())
    _DATA.cleanup()

log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open("smoke_artifacts.out.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
sys.exit(1 if fail else 0)
