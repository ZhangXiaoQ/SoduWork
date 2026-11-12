"""Synthetic inference boundary shared by real Harness2 process fixtures."""
import json

model_calls = []


def complete(model, messages, on_usage=None, *, timeout=20):
    model_calls.append(messages)
    if on_usage:
        on_usage({"input_tokens": 10, "output_tokens": 10})
    if "SODUWORK_HARNESS2_EDIT" in messages[0]["content"]:
        return json.dumps({"files": {"systemprompt.md": "Verify the current request and its evidence."},
                           "notes": "Keep the current request and permission boundaries."})
    return "Inspect the current request, execute it once and verify its result."
