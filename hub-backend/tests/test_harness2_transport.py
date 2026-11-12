"""Transport failures must survive the complete refinement/main boundary."""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

from app.services import harness2_bridge as bridge, harness2_runtime as runtime
from app.services import harness2_provider as provider
from tests.test_harness2_native_provider import Response


def response(payload):
    return Response(payload)


PLAN = {"choices": [{"message": {"content": "Inspect inputs and verify the result."},
                     "finish_reason": "stop"}]}


class Harness2TransportTests(unittest.TestCase):
    def test_provider_failure_keeps_priority_over_budget_after_usage_is_recorded(self):
        from app.services.harness2_budget import RefinementBudget

        payload = {"choices": [{"message": {"content": "partial"}, "finish_reason": "length"}],
                   "usage": {"prompt_tokens": 12000, "completion_tokens": 1}}
        budget = RefinementBudget()
        observed = []
        with patch.object(provider.urllib.request.OpenerDirector, "open",
                          return_value=response(payload)):
            with self.assertRaises(bridge.StructuredFailure) as caught:
                budget.run({"base": "https://fixture.invalid/v1", "key": "private-key", "model": "fixture"},
                           [{"role": "user", "content": "Task"}], bridge.complete, observed.append)
        self.assertEqual(caught.exception.code, "response_truncated")
        self.assertEqual(budget.reported_tokens, 12001)
        self.assertEqual(observed, [{"input_tokens": 12000, "output_tokens": 1}])

    def test_real_refinement_boundary_preserves_safe_transport_category_and_stage(self):
        failures = [
            (TimeoutError("private-key confidential payload"), "model_timeout", "超时"),
            (urllib.error.URLError(TimeoutError("private-key")), "model_timeout", "超时"),
            (urllib.error.HTTPError("https://private.invalid/?key=private-key", 429,
                                   "confidential body", {}, None), "model_http", "429"),
            ({"choices": [{"message": {"content": "private-key"}, "finish_reason": "length"}]},
             "response_truncated", "截断"),
            ({"choices": []}, "response_format", "格式"),
            ({"choices": [{"message": {"content": "private-key"}, "finish_reason": {}}]},
             "response_format", "格式"),
            ({"choices": [{"message": {"content": "private-key"}, "finish_reason": []}]},
             "response_format", "格式"),
        ]
        for failure, code, text in failures:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                stages = []

                def request(req, **_kwargs):
                    system = json.loads(req.data)["messages"][0]["content"]
                    stage = system.split("stage=", 1)[1].splitlines()[0]
                    stages.append(stage)
                    if stage == "base1":
                        return response(PLAN)
                    if stage == "dom1.a1":
                        return response({"choices": [{"message": {"content": '{"files":{},"notes":""}'}, "finish_reason": "stop"}]})
                    if isinstance(failure, Exception):
                        raise failure
                    return response(failure)

                root = Path(directory)
                output = io.StringIO()
                with (patch.dict(os.environ, {
                        "SODUWORK_DATA_ROOT": str(root / "runner"),
                        runtime.MODEL_ENV: json.dumps({
                            "base": "https://fixture.invalid/v1", "key": "private-key", "model": "fixture"}),
                        runtime.EXECUTOR_ENV: sys.executable,
                        runtime.ROOT_ENV: str(root / "evidence"),
                      }),
                      patch.object(provider.urllib.request.OpenerDirector, "open", side_effect=request),
                      patch.object(sys, "stdin", io.StringIO("Plan a minimal answer.")),
                      contextlib.redirect_stdout(output),
                      patch.object(bridge, "execute") as execute):
                    result = bridge.main(["--cwd", str(root), "--refine"])
                self.assertEqual(result, 2)
                execute.assert_not_called()
                self.assertEqual(stages, ["base1", "inv1.a1"],
                                 "No later model call starts after the failed proposal")
                errors = [json.loads(line)["error"] for line in output.getvalue().splitlines()
                          if "error" in json.loads(line)]
                self.assertEqual(errors[-1].get("code"), code)
                self.assertEqual(errors[-1].get("phase"), "inv1.a1")
                self.assertIn(text, errors[-1]["message"])
                if code == "model_http":
                    self.assertEqual(errors[-1].get("httpStatus"), 429)
                self.assertNotIn("private-key", output.getvalue())
                self.assertNotIn("confidential", output.getvalue())
                self.assertNotIn("private.invalid", output.getvalue())


if __name__ == "__main__":
    unittest.main()
