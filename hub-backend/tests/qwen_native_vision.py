"""Exercise an installed Qwen through the production ACP bridge and loopback API.

No company credentials, external model calls or existing Qwen homes are used.
Run with --node and --qwen-entry pointing to the native installation to verify.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", required=True)
    parser.add_argument("--qwen-entry", required=True)
    args = parser.parse_args()
    reports = []
    with tempfile.TemporaryDirectory(prefix="soduwork-qwen-native-") as scratch:
        root = Path(scratch).resolve()
        os.environ.update(DATABASE_URL="sqlite+aiosqlite:///:memory:",
                          AUTH_SECRET="isolated-qwen-vision-probe", SODUWORK_DATA_ROOT=str(root / "data"))
        from app.services import acp_agents, local_base, runtime_images
        from smoke_runner_images import png
        from PIL import Image
        environment_lock = threading.Lock()

        def run_case(name, *, image=True, tool=False, baseline=False, session="", work=None,
                     model="GLM5.3flash", multiple=False):
            workspace = work or root / name
            workspace.mkdir(parents=True, exist_ok=True)
            picture = workspace / "input.png"
            picture.write_bytes(png())
            calls = []

            class Provider(BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass

                def handle(self):
                    try:
                        super().handle()
                    except (ConnectionResetError, BrokenPipeError):
                        # Clients may cancel a pending request. Only completed
                        # requests count toward the transport assertions below.
                        pass

                def do_POST(self):
                    payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    parts = [part for message in payload.get("messages", [])
                             if isinstance(message.get("content"), list) for part in message["content"]]
                    images = [part for part in parts if part.get("type") == "image_url"]
                    text = "\n".join([part.get("text", "") for part in parts] + [message["content"]
                        for message in payload.get("messages", []) if isinstance(message.get("content"), str)])
                    colors = []
                    for part in images:
                        pixels = base64.b64decode(part["image_url"]["url"].split(",", 1)[1])
                        with Image.open(io.BytesIO(pixels)) as decoded:
                            colors.append(list(decoded.convert("RGB").getpixel((0, 0))))
                    calls.append({"path": self.path, "model": payload.get("model"), "images": len(images),
                                  "colors": colors,
                                  "temperature": payload.get("temperature"),
                                  "authorized": self.headers.get("Authorization") == "Bearer loopback-only",
                                  "placeholder": "[image: image/png]" in text,
                                  "mediaInTool": any(message.get("role") == "tool" and isinstance(message.get("content"), list)
                                      and any(part.get("type") == "image_url" for part in message["content"])
                                      for message in payload.get("messages", []))})
                    if tool and len(calls) == 1:
                        delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "read-probe-image",
                            "type": "function", "function": {"name": "read_file",
                            "arguments": json.dumps({"file_path": str(picture)})}}]}
                        finish = "tool_calls"
                    else:
                        delta = {"role": "assistant", "content": "PROBE_IMAGE_OK" if images else "PROBE_TEXT_ONLY"}
                        finish = "stop"
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for change, reason in ((delta, None), ({}, finish)):
                        row = {"id": "probe-completion", "object": "chat.completion.chunk", "created": 1,
                               "model": model, "choices": [{"index": 0, "delta": change, "finish_reason": reason}]}
                        self.wfile.write(("data: " + json.dumps(row) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()

            server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                llm = {"base": f"http://127.0.0.1:{server.server_port}/v1", "key": "loopback-only",
                       "model": model, "input": ["text", "image"] if image else ["text"]}
                cfg = {"llm": llm}
                # All cases retain one native home, as production does on resume.
                inherited = {key: value for key, value in os.environ.items()
                             if not key.startswith(("QWEN_", "OPENAI_", "SODUWORK_RUNNER_"))}
                inherited.update(QWEN_CODE_MODELS_DEV="off", QWEN_CODE_MODELS_DEV_REFRESH="off",
                    QWEN_CODE_SYSTEM_SETTINGS_PATH=str(root / "operator.json"),
                    HTTP_PROXY="", HTTPS_PROXY="", ALL_PROXY="", NO_PROXY="127.0.0.1,localhost",
                    QWEN_CODE_MAX_OUTPUT_TOKENS="1024")
                with environment_lock, patch.dict(os.environ, inherited, clear=True), patch.object(local_base, "_data_root", return_value=str(root / "data")):
                    env = local_base._env_for(local_base._PROFILES["qwen"], cfg, name)
                if baseline:
                    env["QWEN_CODE_SYSTEM_SETTINGS_PATH"] = str(root / "operator.json")
                    env.pop("SODUWORK_QWEN_MODEL_LABEL", None)
                if image and not tool:
                    files = [{"path": str(picture), "name": picture.name, "contentType": "image/png"}]
                    if multiple:
                        second = workspace / "second.png"
                        second.write_bytes(png(b"\0\0\xff"))
                        files.append({"path": str(second), "name": second.name, "contentType": "image/png"})
                    staged = runtime_images.prepare({}, files, str(workspace))
                    env[runtime_images.ENV_KEY] = runtime_images.environment(staged, str(workspace))
                argv = acp_agents.command_argv("qwen", "unused-shim", acp_agents.run_args(session, "plan"), str(workspace), cfg)
                position = argv.index("--") + 1
                argv[position:position + 1] = [str(Path(args.node).resolve()), str(Path(args.qwen_entry).resolve())]
                result = subprocess.run(argv, input="Inspect input.png with read_file." if tool else "Describe the attached image." if image else "Reply briefly.",
                    capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, cwd=workspace, timeout=120)
                events = []
                for line in result.stdout.splitlines():
                    try:
                        events.append(json.loads(line))
                    except ValueError:
                        pass
                if result.returncode or not calls:
                    raise AssertionError(f"{name}: native bridge failed ({result.returncode}); {result.stdout[-2400:]} {result.stderr[-1000:]}")
                expected_images = image and not baseline
                assert bool(calls[-1]["images"]) == expected_images, (name, calls)
                if expected_images:
                    # Qwen's read_file renders a JPEG overview. Check visual
                    # fidelity there; direct uploads must preserve exact pixels.
                    if tool:
                        assert any(red >= 250 and green <= 2 and blue <= 2
                                   for red, green, blue in calls[-1]["colors"]), (name, calls)
                    else:
                        assert [255, 0, 0] in calls[-1]["colors"], (name, calls)
                if multiple:
                    assert calls[-1]["colors"] == [[255, 0, 0], [0, 0, 255]], (name, calls)
                assert all(call["model"] == model for call in calls), (name, calls)
                assert all(call["authorized"] for call in calls), (name, calls)
                if baseline:
                    assert any(call["placeholder"] for call in calls), (name, calls)
                else:
                    expected_temperature = 0.37 if model == "GLM5.3flash" else 0.19
                    assert all(call["temperature"] == expected_temperature for call in calls), (name, calls)
                assert all(not call["mediaInTool"] for call in calls), (name, calls)
                if tool:
                    assert len(calls) >= 2, (name, calls)
                native_id = next((event.get("sessionID") for event in events if event.get("type") == "session"), "")
                assert native_id, (name, "missing native session")
                return {"case": name, "calls": calls, "session": native_id, "workspace": workspace}
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)

        # The unmodified adapter must reproduce the actual missing-pixels bug.
        reports.append(run_case("baseline", baseline=True))
        (root / "operator.json").write_text(json.dumps({"permissions": {"deny": ["Write"]}}), encoding="utf-8")
        (root / "system-defaults.json").write_text(json.dumps({"model": {"generationConfig": {
            "samplingParams": {"temperature": 0.19}}}}), encoding="utf-8")
        shared_home = root / "data" / ".qwen"
        (shared_home / "settings.json").write_text(json.dumps({"model": {"generationConfig": {
            "modalities": {"image": False}, "splitToolMedia": False}}, "modelProviders": {"openai": [{
                "id": "GLM5.3flash", "baseUrl": "$OPENAI_BASE_URL", "envKey": "OPENAI_API_KEY",
                "generationConfig": {"modalities": {"image": False}, "splitToolMedia": False,
                                     "samplingParams": {"temperature": 0.37}}}]}}), encoding="utf-8")
        uploaded = run_case("upload")
        reports.append(uploaded)
        reports.append(run_case("resume", session=uploaded["session"], work=uploaded["workspace"]))
        reports.append(run_case("switch-to-text", image=False, model="gpt-4o",
                                session=uploaded["session"], work=uploaded["workspace"]))
        reports.append(run_case("switch-back-read", tool=True, session=uploaded["session"], work=uploaded["workspace"]))
        reports.append(run_case("tool-read", tool=True))
        reports.append(run_case("multi-image", multiple=True))
        reports.append(run_case("text", image=False, model="gpt-4o"))
        reports.append(run_case("tool-text", image=False, tool=True, model="gpt-4o"))
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = [pool.submit(run_case, "parallel-image"),
                       pool.submit(run_case, "parallel-text", image=False)]
            reports.extend(item.result() for item in pending)
    print(json.dumps([{key: value for key, value in row.items() if key not in ("session", "workspace")}
                      for row in reports], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
