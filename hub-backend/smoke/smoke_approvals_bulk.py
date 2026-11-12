# -*- coding: utf-8 -*-
"""Verify bulk approval-decision and assignment queries match per-request results while avoiding
N+1 reads.
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, ".")
_fixture = tempfile.TemporaryDirectory(prefix="soduwork-smoke-apbulk-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (Path(_fixture.name) / ".smoke.db").as_posix()
ok = fail = 0


def chk(n, c, e=""):
    global ok, fail
    if c:
        ok += 1
        print("  PASS  " + n)
    else:
        fail += 1
        print("  FAIL  " + n + ("  << " + str(e)[:200] if e else ""))


RIDS = ["apb-r1", "apb-r2", "apb-r3"]
UID = "apb-user"


async def main():
    from sqlalchemy import delete
    from app import automation_models as am
    from app.db import SessionLocal, init_db
    from app.services import release_control, approval_routing
    await init_db()

    async def _purge(s):
        for rid in RIDS:
            await s.execute(delete(am.ApprovalDecision).where(am.ApprovalDecision.request_id == rid))
            await s.execute(delete(am.ApprovalAssignment).where(am.ApprovalAssignment.request_id == rid))
            await s.execute(delete(am.ApprovalRequest).where(am.ApprovalRequest.id == rid))
        await s.commit()

    async with SessionLocal() as s:
        await _purge(s)
        for rid in RIDS:
            s.add(am.ApprovalRequest(id=rid, task_id="apb-t", artifact_version_id="apb-a", action="review"))
        # Prepare requests with two, one, and zero decisions.
        s.add(am.ApprovalDecision(request_id="apb-r1", user_id="u1", decision="approve", note="a"))
        s.add(am.ApprovalDecision(request_id="apb-r1", user_id="u2", decision="approve", note="b"))
        s.add(am.ApprovalDecision(request_id="apb-r2", user_id="u1", decision="reject", note="c"))
        # Assign the first two requests to the target user and the third elsewhere.
        s.add(am.ApprovalAssignment(request_id="apb-r1", user_id=UID, user_name="me"))
        s.add(am.ApprovalAssignment(request_id="apb-r2", user_id=UID, user_name="me"))
        s.add(am.ApprovalAssignment(request_id="apb-r3", user_id="other", user_name="x"))
        await s.commit()

        db = await release_control.decisions_bulk(s, RIDS)
        chk("decisions_bulk：r1 两条", len(db.get("apb-r1", [])) == 2, db.get("apb-r1"))
        chk("decisions_bulk：r2 一条", len(db.get("apb-r2", [])) == 1)
        chk("decisions_bulk：r3 零条（不进结果）", "apb-r3" not in db)
        for rid in ["apb-r1", "apb-r2"]:
            one = await release_control._decisions(s, rid)
            chk("★decisions_bulk == 逐条 _decisions（%s，含顺序）" % rid,
                [d.id for d in db.get(rid, [])] == [d.id for d in one])
        chk("decisions_bulk([]) == {}", await release_control.decisions_bulk(s, []) == {})

        ab = await approval_routing.assignments_for_user_bulk(s, RIDS, UID)
        chk("assignments_bulk：r1/r2 命中 UID", "apb-r1" in ab and "apb-r2" in ab)
        chk("assignments_bulk：r3 是别人、不进结果", "apb-r3" not in ab)
        for rid in ["apb-r1", "apb-r2"]:
            one = await approval_routing.assignment_for_user(s, rid, UID)
            chk("★assignments_bulk == 逐条 assignment_for_user（%s）" % rid,
                ab.get(rid) is not None and one is not None and ab.get(rid).id == one.id)
        chk("assignments_bulk([], uid) == {}",
            await approval_routing.assignments_for_user_bulk(s, [], UID) == {})

        await _purge(s)


asyncio.run(main())
print(f"\n{ok} PASS / {fail} FAIL")
sys.exit(1 if fail else 0)
