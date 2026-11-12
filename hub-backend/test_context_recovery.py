"""Context saturation must never permanently poison a conversation."""
import json
from unittest.mock import Mock
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
from app.services import local_base as base, local_ctx as ctx, local_stream as stream
from app.services import local_context_policy as policy

class ContextRecoveryTests(unittest.TestCase):
    def test_legacy_harness_session_migrates_through_the_existing_history_relay(self):
        self.row.update(cli="harness2", cliSid="ses_legacy_executor", state="done", tokens={})
        self.mock_profile("harness2", dict(base._PROFILES["harness2"], bin=lambda: "fixture",
            start=lambda *_: ["new-native"], resume=lambda sid, *_: ["resume-native", sid]))
        result = ctx.prepare_resume(self.ref, "Continue without repeating completed work", {})
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.spawn.call_args.args[1], ["new-native"])
        self.assertIn("仅允许分析", self.spawn.call_args.args[2])
        self.assertIn("Continue without repeating completed work", self.spawn.call_args.args[2])
        self.assertEqual(self.row["contextSegments"][0]["sid"], "ses_legacy_executor")
        self.assertEqual(self.row["taskId"], "keep-task")
        self.assertEqual(self.row["mode"], "plan")
        self.assertEqual(self.row["segment"], 2)

    def test_independent_harness_session_resumes_without_relaying_or_losing_identity(self):
        sid = "h2_" + "a" * 32
        self.row.update(cli="harness2", cliSid=sid, state="done", tokens={})
        self.mock_profile("harness2", dict(base._PROFILES["harness2"], bin=lambda: "fixture",
            start=lambda *_: ["new-native"], resume=lambda value, *_: ["resume-native", value]))
        with patch.object(ctx, "_relay", side_effect=AssertionError("Native session was replaced")):
            self.assertTrue(ctx.prepare_resume(self.ref, "Continue", {})["ok"])
        self.assertEqual(self.spawn.call_args.args[1], ["resume-native", sid])
        self.assertEqual(self.row["cliSid"], sid)
        self.assertEqual(self.row["segment"], 1)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ref = "context-regression"
        self.row = dict(cli="pi", cliSid=self.ref, ws=self.temp.name, taskId="keep-task", mode="plan",
            state="running", segment=1, round=1, lastPrompt="只分析，不修改；本轮回答验收标准",
            title="原任务", cfg={"networkAllowed": False}, seq=0, lines=[
                {"kind": "user", "text": "仅允许分析"}, {"kind": "say", "text": "已读完资料，尚未更改"}],
            tokens={"input": 9000}, ctxWindow=10000, ctxWindowKnown=True,
            usage={"input": 11111}, executionPolicy={"readOnly": True})
        base._RUNS[self.ref] = self.row
        self.addCleanup(base._RUNS.pop, self.ref, None)
        self.mock_attr(base, "_STORE", self.temp.name)
        self.mock_attr(stream, "_load_windows", lambda: {})
        self.spawn = Mock()
        self.mock_attr(stream, "_spawn", self.spawn)
        self.runtime = self.ref, self.row, self.spawn

    def mock_attr(self, obj, name, value):
        handle = patch.object(obj, name, value)
        handle.start()
        self.addCleanup(handle.stop)

    def mock_profile(self, cli, value):
        handle = patch.dict(base._PROFILES, {cli: value})
        handle.start()
        self.addCleanup(handle.stop)

    def check_base(self, cli):
        ref, row, spawn = self.runtime
        row["cli"] = cli
        prof = dict(base._PROFILES[cli], bin=lambda: "fixture", compact=None,
                    start=lambda sid, mode, ws, cfg: [sid, mode],
                    resume=lambda sid, mode, ws, cfg: [sid, mode])
        self.mock_profile(cli, prof)
        assert ctx._recover_overflow(ref)
        args = spawn.call_args.args
        assert args[1][0] != ref and args[1][1] == "plan"
        assert "本轮回答验收标准" in args[2] and "仅允许分析" in args[2]
        assert args[4] == ref and row["taskId"] == "keep-task"
        assert row["round"] == 1 and row["usage"]["input"] == 11111
        assert row["executionPolicy"] == {"readOnly": True}
        assert row["contextSegments"][0]["sid"] == ref
        if prof.get("own_session"):
            native = row["cliSid"]
            row["state"] = "done"
            assert stream._resume(ref, "继续分析")["ok"]
            assert spawn.call_args.args[1][0] == native


    def test_new_user_round_resets_retry_budget(self):
        ref, row, spawn = self.runtime
        self.mock_profile("pi", dict(base._PROFILES["pi"], bin=lambda: "fixture", compact=None))
        row["overflowTried"] = 2
        row["tokens"] = {}
        assert stream._resume(ref, "新的本轮要求")["ok"]
        assert row["overflowTried"] == 0 and row["round"] == 2
        assert ctx._recover_overflow(ref)
        assert "新的本轮要求" in spawn.call_args.args[2]


    def test_fresh_credentials_used_before_native_compaction(self):
        ref, row, spawn = self.runtime
        compact = Mock(side_effect=lambda r: r["cfg"]["llm"]["key"] == "fresh")
        self.mock_profile("pi", dict(base._PROFILES["pi"], bin=lambda: "fixture", compact=compact))
        assert stream._resume(ref, "继续", {"llm": {"key": "fresh", "contextWindow": 10000}})["ok"]
        assert compact.call_count == 1 and row["segment"] == 1
        assert row["round"] == 2 and row["tokens"] == {}


    def test_stop_during_compaction_never_restarts(self):
        ref, row, spawn = self.runtime
        def compact(r):
            assert stream.stop_sync({}, ref)["ok"]
            return False
        self.mock_profile("pi", dict(base._PROFILES["pi"], bin=lambda: "fixture", compact=compact))
        assert ctx._recover_overflow(ref)
        assert row["state"] == "stopped" and not spawn.called


    def test_oversize_request_archived_and_checkpoint_bounded(self):
        ref, row, _ = self.runtime
        text = "FIRST REQUIREMENT " + "材料" * 200000 + " LAST REQUIREMENT"
        brief = ctx._handoff_brief(ref, text)
        assert len(brief) < 4000
        assert "FIRST REQUIREMENT" in brief and "LAST REQUIREMENT" in brief
        from pathlib import Path
        archived = json.loads(next(Path(base._store_dir(ref)).glob("context-request-*.json")).read_text(encoding="utf-8"))
        assert archived["request"] == text

    def test_error_shapes_recover(self):
        events = [
        {"type": "error", "message": "context length exceeded"},
        {"type": "message_end", "message": {"stopReason": "error", "errorMessage": "prompt is too long"}},
        {"type": "result", "is_error": True, "result": "maximum context length is 8192"},
        {"error": {"name": "ContextOverflowError", "message": "too large"}},
        {"error": {"name": "AcpBridgeError", "message": "context window exceeded"}},
    ]
        for event in events:
            with self.subTest(event=event):
                term = {}
                policy.observe({}, event, term)
                assert term["overflow"]
                policy.observe({}, {"type": "turn.completed"}, term)
                assert not term.get("overflow") and not term.get("isError")


    def test_normal_conversation_does_not_trigger_recovery(self):
        term = {}
        policy.observe({}, {"type": "message_end", "message": {"role": "assistant", "stopReason": "stop", "content": "context window exceeded 是一个错误"}}, term)
        assert not term
        assert not policy.OVERFLOW.search("Context window is 128000 tokens")


    def test_windows_and_cached_input(self):
        assert stream._window_for({"llm": {"model": "x", "contextWindow": 32000}}) == (32000, True)
        assert policy.window({"llm": {"contextWindow": 128000, "contextWindowKnown": False}}) == 128000
        assert policy.context_input({"input": 20, "cacheRead": 5000, "cacheCreation": 100}) == 5120
        assert policy.context_input({"input_tokens": 5120, "cached_tokens": 5000}) == 5120
        row = {}
        policy.observe(row, {"part": {"contextWindow": 32768}}, {})
        assert row["ctxWindow"] == 32768 and row["ctxWindowKnown"]


    def test_opencode_cleanup_does_not_override_success(self):
        ref, row, _ = self.runtime
        import urllib.request
        self.mock_attr(ctx, "_opencode_bin", lambda: "fixture")
        self.mock_attr(ctx, "_env_for", lambda *a: {})
        self.mock_attr(ctx.time, "sleep", lambda *a: None)
        self.mock_attr(ctx.subprocess, "Popen", lambda *a, **k: Mock(pid=555))
        killed = Mock()
        self.mock_attr(stream, "_kill_pid_tree", killed)
        response = Mock(status=200)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=None)
        self.mock_attr(urllib.request, "build_opener", lambda *a: Mock(open=Mock(return_value=response)))
        assert ctx._oc_compact(row) is True
        killed.assert_called_once()

    def test_proxy_preserves_context_code_without_leaking_upstream(self):
        from app.api.ai_proxy import _err
        raw = json.dumps({"error": {"code": "context_length_exceeded", "message":
            "maximum context length is 8,192 tokens", "api_key": "DO_NOT_EXPOSE"}})
        response = _err(400, "HTTP 400", raw)
        body = json.loads(response.body)
        assert body["error"]["code"] == "context_length_exceeded"
        assert "8192" in body["error"]["message"]
        assert "DO_NOT_EXPOSE" not in response.body.decode()
        ordinary = _err(400, "请求不正确", '{"api_key":"DO_NOT_EXPOSE"}')
        assert json.loads(ordinary.body)["error"]["code"] == 400

    def test_proxy_preserves_a_safe_image_rejection_code(self):
        from app.api.ai_proxy import _err
        response = _err(400, "当前所选模型服务拒绝图片输入，请手动选择支持图片的模型后重试；原图已保留")
        body = json.loads(response.body)
        assert body["error"]["code"] == "image_input_rejected"
        assert body["error"]["message"] == "Image input rejected."


    def test_real_pi_resume_preserves_plan_tools(self):
        self.mock_attr(base, "_pi_cli_js", lambda: "fixture-cli.js")
        args = base._PROFILES["pi"]["resume"]("native", "plan", self.temp.name, {})
        assert "--tools" in args
        assert args[args.index("--tools") + 1] == "read,list,glob,grep"

    def test_actual_start_and_resume_profiles_keep_acp_plan_mode(self):
        from app.services import acp_agents
        for key in ("qwen", "dsh", "codex-harness"):
            prof = base._PROFILES[key]
            start = prof["start"]("ignored", "plan", self.temp.name, {})
            native, mode = acp_agents._metadata(start)
            assert native == "" and mode == "plan"
            resume = prof["resume"]("real-native-session", "plan", self.temp.name, {})
            assert acp_agents._metadata(resume) == ("real-native-session", "plan")

    def test_dispatch_passes_selected_model_window_without_stale_capacity(self):
        from app.services.ai_exec import with_llm
        before = {"cfg": {"llm": {"contextWindow": 128000}}, "localCfg": {"llm": {}}}
        changed = with_llm(before, {"base": "http://model.invalid", "key": "fixture", "model": "small", "contextWindow": 8192})
        assert policy.window(changed["cfg"]) == 8192
        assert policy.window(changed["localCfg"]) == 8192
        unknown = with_llm(changed, {"base": "http://model.invalid", "key": "fixture", "model": "unknown"})
        assert policy.window(unknown["cfg"]) == 128000

    def test_dispatch_carries_thinking_contract_and_clears_it_on_model_switch(self):
        from app.services.ai_exec import with_llm
        before = {"cfg": {"llm": {}}, "localCfg": {"llm": {}}}
        model = {"base": "http://model.invalid", "key": "fixture", "model": "reasoner",
                 "reasoning": True, "thinkingMode": "always", "thinkingFormat": "zai",
                 "supportsReasoningEffort": True, "thinkingLevelMap": {"off": None, "low": "low"}}
        changed = with_llm(before, model)
        for key in ("cfg", "localCfg"):
            assert changed[key]["llm"]["thinkingLevelMap"] == {"off": None, "low": "low"}
            assert changed[key]["llm"]["thinkingFormat"] == "zai"
            assert before[key]["llm"] == {}
        next_model = {"base": "http://model.invalid", "key": "fixture", "model": "plain"}
        switched = with_llm(changed, next_model)
        for key in ("cfg", "localCfg"):
            assert "thinkingLevelMap" not in switched[key]["llm"]
            assert "thinkingFormat" not in switched[key]["llm"]
            assert "reasoning" not in switched[key]["llm"]



for cli in list(base._PROFILES):
    setattr(ContextRecoveryTests, "test_base_" + cli.replace("-", "_"), lambda self, name=cli: self.check_base(name))

if __name__ == "__main__":
    unittest.main()
