"""Checks executed against the real isolated Runner, never a model service."""
import asyncio
import json
from pathlib import Path


async def exercise(machine, agent, workspace, until, refs):
    from app.services import local_base
    started = await machine._job({"op": "job.dispatch", "cli": agent, "dispatchId": "dialogue-" + agent,
        "task": {"id": "dialogue-" + agent, "title": "DIALOGUE_QUESTION", "note": "DIALOGUE_QUESTION"},
        "ctx": {"workDir": str(workspace), "workRoot": str(workspace), "conversationMode": "adaptive",
                "conversationUserText": "DIALOGUE_QUESTION"}, "cfg": {}})
    assert started["ok"], started
    ref = started["data"]["ref"]
    refs.add(ref)

    async def settled(expected_round):
        async def read():
            response = await machine._job({"op": "job.session", "ref": ref, "limit": 1000})
            data = response["data"]
            return data if data.get("status") in {"done", "failed"} and data.get("round", 0) >= expected_round else None
        return await until(read)

    first = await settled(1)
    assert first["status"] == "done" and not first["error"], first
    sid = first["cliSid"]
    await asyncio.sleep(.2)
    assert local_base._RUNS[ref]["round"] == 1, "interactive question must await its human"
    expected = ["DIALOGUE_QUESTION"]
    outcomes = []
    for marker in ("DIALOGUE_EMPTY", "DIALOGUE_SUCCESS", "DIALOGUE_EMPTY", "DIALOGUE_THINKING", "DIALOGUE_ERROR", "DIALOGUE_EXIT", "DIALOGUE_SUCCESS"):
        before = local_base._RUNS[ref]["round"]
        reply = await machine._job({"op": "job.comment", "ref": ref, "text": marker,
            "recordUser": True, "turnId": f"{agent}:{before}:{marker}", "cfg": {}})
        assert reply["ok"], reply
        data = await settled(before + 1)
        expected.append(marker)
        assert data["cliSid"] == sid, data
        expected_state = "done" if marker == "DIALOGUE_SUCCESS" else "failed"
        assert data["status"] == expected_state, (marker, data)
        if marker == "DIALOGUE_EMPTY":
            # Harness2 has already emitted real planning progress in this turn;
            # a missing final answer is incomplete work, not an empty execution.
            expected_failure = "execution_incomplete" if agent == "harness2" else "execution_no_output"
            assert data["failureKind"] == expected_failure and data["error"], data
            if agent == "harness2":
                current = [row for row in data["items"] if row.get("round") == data["round"]]
                assert len([row for row in current if row.get("kind") == "usage"]) == 7, current
                assert not any(row.get("kind") == "say" for row in current), current
        elif marker == "DIALOGUE_ERROR":
            expected_error = {"pi": "模型调用失败，已有进度已保留；请重试或切换可用模型。",
                              "harness2": "Google Harness² 调用模型失败"}.get(agent, "fixture provider failure")
            assert expected_error in data["error"], data
            if agent in {"pi", "harness2"}:
                assert "fixture provider failure" not in data["error"], "Raw provider errors must be sanitized"
        elif marker == "DIALOGUE_THINKING":
            assert data["failureKind"] == "execution_incomplete" and data["error"], data
        elif marker == "DIALOGUE_EXIT":
            assert data["error"], "abrupt exit must include an actionable failure"
        elif marker == "DIALOGUE_SUCCESS":
            assert not data["error"], data
        outcomes.append({"input": marker, "state": data["status"], "failureKind": data.get("failureKind")})
    rows = [json.loads(line) for line in (workspace / "peer.jsonl").read_text(encoding="utf-8").splitlines()]
    prompts = [row for row in rows if row["event"] == "prompt"]
    assert [row["label"] for row in prompts] == expected, prompts
    assert len({row["sid"] for row in prompts}) == 1
    last = local_base._RUNS[ref]
    assert len([row for row in last["lines"] if row.get("kind") == "say" and row["text"] == "The requested follow-up is complete."]) == 2
    local_base._save_meta(ref)
    metadata = json.loads((Path(local_base._store_dir(ref)) / "meta.json").read_text(encoding="utf-8"))
    assert metadata["conversationMode"] == "adaptive" and metadata["turnStartSeq"] > 0
    print(json.dumps({"ok": True, "agent": agent, "sameNativeSession": True,
        "questionNotAutoAnswered": True, "exactRequests": len(prompts), "outcomes": outcomes,
        "repeatedAnswerPreserved": True, "durableTurnBoundary": True}))
