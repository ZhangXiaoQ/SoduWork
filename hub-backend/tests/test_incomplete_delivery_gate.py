"""Prevent incomplete turns from producing candidate versions or acceptance requests. Only
completed outcomes create deliverables and reviews; incomplete outputs remain process evidence.
A failed receipt revokes same-turn automatic pending reviews, and collection detects
structurally truncated code without rejecting dialect or version differences.
"""

import json
import unittest

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.db import Base
from app.services import conversation_turns, delivery_manifest
from tests.sqlite_schema import create_fresh_sqlite_schema


class _Base(unittest.IsolatedAsyncioTestCase):
    async def _prepared(self, turn_state="running"):
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await create_fresh_sqlite_schema(connection, Base.metadata)
        session = sessions()
        await session.__aenter__()
        session.add(models.Client(id="device-owner", name="本机", user_ref="u-exec"))
        session.add(models.User(id="u-requester", username="requester",
                                display_name="王振义", is_active=True))
        session.add(models.User(id="u-exec", username="executor", is_active=True))
        await session.flush()
        # These regressions exercise automatic review; undeclared tasks default to manual submission.
        session.add(models.Task(
            id="scene-task", title="写一个网页游戏", status="doing",
            owner_client_id="device-owner", requester_user_id="u-requester",
            created_by="u-requester",
            work_routing={"executionSubmissionMode": "auto",
                          "conversationTurn": {"turnId": "turn-9", "conversationId": "conv-9",
                                               "state": turn_state}}))
        await session.commit()
        return engine, session, await session.get(models.Task, "scene-task")

    async def _requests(self, session):
        return (await session.execute(select(am.ApprovalRequest).where(
            am.ApprovalRequest.task_id == "scene-task"))).scalars().all()

    async def _event_kinds(self, session):
        return [row[0] for row in (await session.execute(
            select(models.TaskEvent.kind).where(
                models.TaskEvent.task_id == "scene-task"))).all()]

    async def _dispose(self, engine, session):
        await session.__aexit__(None, None, None)
        await engine.dispose()


class IncompleteTurnDeliveryTests(_Base):
    """Incomplete collection retains evidence without creating a version or review."""

    async def test_incomplete_delivery_defers_review(self):
        engine, session, task = await self._prepared()
        try:
            result = await conversation_turns.deliver_artifacts(
                session, task, conversation_id="conv-9", turn_id="turn-9",
                provider="conversation", outcome="incomplete",
                files=[("scene.js", "function start(){\n".encode("utf-8"), "text/javascript")])
            self.assertTrue(result.get("ok"))
            self.assertTrue(result.get("deferred"))
            # Do not create candidate versions, reviews, or submission events.
            versions = (await session.execute(select(am.ArtifactVersion).where(
                am.ArtifactVersion.task_id == "scene-task"))).scalars().all()
            self.assertEqual(versions, [])
            self.assertEqual(await self._requests(session), [])
            kinds = await self._event_kinds(session)
            self.assertNotIn("artifact.submitted_for_review", kinds)
            self.assertIn("artifact.delivery_deferred", kinds)
            # Persist files as process evidence rather than deliverables.
            attachment = (await session.execute(select(models.Attachment).where(
                models.Attachment.task_id == "scene-task"))).scalar_one()
            self.assertEqual(attachment.role, "process")
        finally:
            await self._dispose(engine, session)

    async def test_completed_delivery_still_submits(self):
        """Completed turns still create candidate versions and reviews for valid output."""
        engine, session, task = await self._prepared()
        try:
            result = await conversation_turns.deliver_artifacts(
                session, task, conversation_id="conv-9", turn_id="turn-9",
                provider="conversation", outcome="completed",
                files=[("作文.md", "写作文".encode("utf-8"), "text/markdown")])
            self.assertTrue(result.get("ok"))
            self.assertNotIn("deferred", result)
            requests = await self._requests(session)
            self.assertEqual([r.action for r in requests], ["review"])
            self.assertEqual([r.status for r in requests], ["pending"])
            assignments = (await session.scalars(select(am.ApprovalAssignment).where(
                am.ApprovalAssignment.request_id == requests[0].id))).all()
            self.assertEqual([row.user_id for row in assignments], ["u-requester"])
            self.assertIn("artifact.submitted_for_review", await self._event_kinds(session))
        finally:
            await self._dispose(engine, session)


    async def test_completed_delivery_without_creator_remains_unassigned(self):
        engine, session, task = await self._prepared()
        try:
            task.created_by = None
            await session.commit()
            await conversation_turns.deliver_artifacts(
                session, task, conversation_id="conv-9", turn_id="turn-9",
                provider="conversation", outcome="completed",
                files=[("review.md", b"Complete report", "text/markdown")])
            requests = await self._requests(session)
            self.assertEqual([r.status for r in requests], ["pending"])
            assignments = (await session.scalars(select(am.ApprovalAssignment).where(
                am.ApprovalAssignment.request_id == requests[0].id))).all()
            self.assertEqual(assignments, [])
            kinds = await self._event_kinds(session)
            self.assertIn("approval.unassigned", kinds)
            self.assertNotIn("artifact.submitted_for_review", kinds)
        finally:
            await self._dispose(engine, session)


class FailCancelsAutoReviewTests(_Base):
    """Applying a failed receipt revokes automatic pending reviews from the same turn."""

    async def test_rejection_survives_late_native_files_until_executor_starts_new_turn(self):
        from unittest.mock import AsyncMock, patch
        from app.api import approvals
        from app.realtime import hub
        from app.services import tasks, task_requirements
        engine, session, task = await self._prepared()
        try:
            session.add(models.Client(id="review-device", user_ref="u-requester"))
            await session.commit()
            async def deliver(name, turn="turn-9"):
                return await conversation_turns.deliver_artifacts(session, task,
                    conversation_id="conv-9", turn_id=turn, outcome="completed",
                    files=[(name, b"Complete revised report", "text/markdown")])
            with patch.object(hub, "publish", new=AsyncMock()):
                await deliver("report.md")
                request = (await self._requests(session))[0]
                await approvals.decide(request.id, {"decision": "reject", "note": "Revise report"},
                    await session.get(models.Client, "review-device"), session)
                late = await deliver("late.md")
                self.assertTrue(late["pendingRework"])
                self.assertEqual([r.status for r in await self._requests(session)], ["rejected"])
                await conversation_turns.apply(session, task,
                    {"action": "complete", "turnId": "turn-9", "conversationId": "conv-9"})
                await session.commit()
                for _ in range(3):
                    worker = await session.get(models.Client, "device-owner")
                    api = await task_requirements.decorate(session, worker, task,
                        await tasks.task_to_api_live(session, task))
                    self.assertEqual(api["requirementStage"], "delivering")
                    self.assertTrue(api["canContinueExecution"])
                    self.assertEqual(api["workRouting"]["reworkPending"]["feedback"], "Revise report")
                for action in ("prepare", "start"):
                    await conversation_turns.apply(session, task,
                        {"action": action, "turnId": "turn-10", "conversationId": "conv-9"})
                await session.commit()
                self.assertNotIn("reworkPending", task.work_routing)
                result = await deliver("revised.md", "turn-10")
                self.assertNotIn("deferred", result)
                await deliver("revised.md", "turn-10")
                self.assertEqual(sorted(r.status for r in await self._requests(session)), ["pending", "rejected"])
                api = await tasks.task_to_api_live(session, task)
                self.assertEqual(api["requirementStage"], "reviewing")
        finally:
            await self._dispose(engine, session)

    async def test_fail_cancels_pending_review_of_same_conversation(self):
        engine, session, task = await self._prepared()
        try:
            # Collect valid completed output to create an automatic pending review.
            await conversation_turns.deliver_artifacts(
                session, task, conversation_id="conv-9", turn_id="turn-9",
                provider="conversation", outcome="completed",
                files=[("作文.md", "正文".encode("utf-8"), "text/markdown")])
            requests = await self._requests(session)
            self.assertEqual([r.status for r in requests], ["pending"])
            # A subsequent failure for that turn must withdraw its review.
            await conversation_turns.apply(session, task, {
                "action": "fail", "turnId": "turn-9", "conversationId": "conv-9",
                "executor": "native"})
            requests = await self._requests(session)
            self.assertEqual([r.status for r in requests], ["cancelled"])
            kinds = await self._event_kinds(session)
            self.assertIn("artifact.review_cancelled", kinds)
            # Persist the turn's failed terminal state normally.
            task = await session.get(models.Task, "scene-task")
            self.assertEqual(task.work_routing["conversationTurn"]["state"], "failed")
        finally:
            await self._dispose(engine, session)

    async def test_fail_keeps_other_reviews(self):
        """Preserve pending reviews from other turns or execution sources."""
        engine, session, task = await self._prepared()
        try:
            version = am.ArtifactVersion(
                task_id="scene-task", kind="files", seq=1, state="current",
                manifest={"primary": [{"name": "旧版.md"}]},
                source_ref="workflow-run:xyz", checksum="test-checksum-1",
                created_by_kind="runner", created_by_id="runner-1", created_by_name="执行机")
            session.add(version)
            await session.flush()
            session.add(am.ApprovalRequest(
                task_id="scene-task", artifact_version_id=version.id,
                action="review", status="pending", required_count=1))
            await session.commit()
            await conversation_turns.apply(session, task, {
                "action": "fail", "turnId": "turn-9", "conversationId": "conv-9",
                "executor": "native"})
            requests = await self._requests(session)
            self.assertEqual([r.status for r in requests], ["pending"])
        finally:
            await self._dispose(engine, session)


class CodeTruncationTests(_Base):
    """Detect truncated code during collection while accepting complete code."""

    async def test_truncated_js_and_py_marked_invalid(self):
        import shutil
        truncated_js = b"const list = [1, 2, 3];\nfunction boot(a) {\n  return a.map(x => {\n"
        full_js = b"const greet = (name) => `hi ${name}`;\nmodule.exports = { greet };\n"
        truncated_py = b"def run(items):\n    return sorted(\n"
        full_py = b"def run(items):\n    return sum(items)\n"
        for name, data in (("坏.js", truncated_js), ("半截.py", truncated_py)):
            reason = await delivery_manifest.code_truncation(name, data)
            self.assertIsNotNone(reason, name + " 应被识别为截断")
        for name, data in (("完整.js", full_js), ("完整.py", full_py)):
            self.assertIsNone(await delivery_manifest.code_truncation(name, data),
                              name + " 不应被误拦")
        if not shutil.which("node"):
            self.skipTest("环境无 node，js 校验按设计 fail-open")

    async def test_truncated_js_does_not_block_valid_md(self):
        """Keep truncated code as evidence while delivering other valid outputs from the same turn.

        """
        engine, session, task = await self._prepared()
        try:
            result = await conversation_turns.deliver_artifacts(
                session, task, conversation_id="conv-9", turn_id="turn-9",
                provider="conversation", outcome="completed",
                files=[("说明.md", "玩法说明".encode("utf-8"), "text/markdown"),
                       ("scene.js", b"function boot(a) {\n  return a.map(x => {\n",
                        "text/javascript")])
            self.assertTrue(result.get("ok"))
            names = json.dumps(
                (await session.execute(select(am.ArtifactVersion).where(
                    am.ArtifactVersion.task_id == "scene-task"))).scalars().first().manifest or {},
                ensure_ascii=False)
            self.assertIn("说明.md", names)
            self.assertNotIn("scene.js", names)
            self.assertTrue(result.get("invalid"))
            self.assertIn("截断", result["invalid"][0]["reason"])
        finally:
            await self._dispose(engine, session)


if __name__ == "__main__":
    unittest.main()
