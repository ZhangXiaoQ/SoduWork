# -*- coding: utf-8 -*-
"""Offline Runner-Hub bin1 frame tests. Binary terminal/output payloads reduce base64 overhead, but
both hello and welcome must advertise bin1; otherwise retain legacy encoding for asynchronous
upgrades. Real PTY interaction is covered by smoke/smoke_runner_term.py after negotiation.
"""
import json
import os
import sys

sys.path.insert(0, ".")

from app.services import ws_frames  # noqa: E402

ok = fail = 0


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print("  PASS  " + name)
    else:
        fail += 1
        print("  FAIL  " + name + ("  << " + str(extra)[:200] if extra else ""))


# Verify encoding and decoding round trips.
payload = os.urandom(1024 * 1024)
buf = ws_frames.encode(ws_frames.KIND_REPLY_CHUNK,
                       {"id": "rpc-1", "ok": True,
                        "data": {"offset": 0, "size": len(payload), "eof": True}},
                       payload)
kind, meta, out = ws_frames.decode(buf)
chk("roundtrip：kind/meta/payload 原样回来",
    kind == ws_frames.KIND_REPLY_CHUNK and meta["id"] == "rpc-1"
    and meta["data"]["size"] == len(payload) and out == payload)

k2, m2, p2 = ws_frames.decode(ws_frames.encode(ws_frames.KIND_TERM_OUT, {"task": "任务甲"}, b""))
chk("终端帧：中文 meta + 空 payload", k2 == 1 and m2["task"] == "任务甲" and p2 == b"")

# Reject malformed frames; callers decide whether to discard them or close the connection.
for bad, why in ((b"", "空"), (b"\x01\x00", "太短"),
                 (b"\x01\xff\xff\xff\xff" + b"x" * 10, "meta 长度越界")):
    try:
        ws_frames.decode(bad)
        chk("坏帧拒绝（%s）" % why, False, "没抛")
    except ValueError:
        chk("坏帧拒绝（%s）" % why, True)

# Verify lower transmitted byte counts for equivalent payloads.
import base64  # noqa: E402

old_wire = json.dumps({"op": "reply", "id": "rpc-1", "ok": True,
                       "data": {"b64": base64.b64encode(payload).decode("ascii"),
                                "offset": 0, "size": len(payload), "eof": True}})
chk("★1MB 分片：二进制帧比 base64+JSON 至少省 20%%（实测 %.0f%%）"
    % (100 - len(buf) * 100.0 / len(old_wire)),
    len(buf) < len(old_wire) * 0.8, (len(buf), len(old_wire)))

# Verify capability negotiation.
from app.services import runner_hub  # noqa: E402


class _WS:
    pass


old = runner_hub._Runner(_WS(), {"runnerId": "r-old", "host": "老机器"})
new = runner_hub._Runner(_WS(), {"runnerId": "r-new", "host": "新机器", "caps": ["bin1"]})
chk("旧 runner（hello 无 caps）不启用二进制", old.bin is False and old.caps == [])
chk("新 runner（hello 带 bin1）启用二进制", new.bin is True)

# Capability names are protocol identifiers, not display labels. Truncating
# executionSelection1 prevents durable continuation from reaching the Runner.
advertised = ["bin1", "handoff1", "executionSelection1", "sessionAck1", "turnFiles1",
              "turnSkills1", "desktopCapabilities1", "desktopPluginTurn1",
              "desktopPluginStart1", "desktopLibrary1", "admit1"]
current = runner_hub._Runner(_WS(), {"runnerId": "r-current", "caps": advertised})
chk("完整保留续聊与执行切换能力", current.caps == advertised, current.caps)

from app.services.cluster_runtime import RemoteRunner  # noqa: E402

remote = RemoteRunner("other-hub", {**current.api(), "clusterToken": "fixture-only"})
chk("集群转发保留同一组协议能力", remote.caps == advertised, remote.caps)
remote.update({"caps": ["executionSelection1", "admit1"]})
chk("集群心跳更新不截断能力名", remote.caps == ["executionSelection1", "admit1"], remote.caps)

malformed = runner_hub._Runner(_WS(), {"runnerId": "r-malformed", "caps": "bin1"})
chk("能力列表不接受字符串冒充数组", malformed.caps == [] and not malformed.bin)
bounded = runner_hub._Runner(_WS(), {"runnerId": "r-bounded", "caps": [
    "bin1" + "x" * 64, None, {}, "", "admit1", "admit1"]})
chk("无效或超长能力不截断成其他标识", bounded.caps == ["admit1"], bounded.caps)
# The protocol grew to 32 slots in 777874b3 so desktop admission is not truncated.
# Exercise both the complete current hello and a payload beyond that hard bound.
limited = runner_hub._Runner(_WS(), {"runnerId": "r-limit", "caps": [f"cap{i}" for i in range(40)]})
chk("Protocol capabilities retain the 32-entry bound",
    limited.caps == [f"cap{i}" for i in range(32)])

# Hub must accept both legacy and binary output chunks.
from app.services import ai_remote  # noqa: E402

chk("分片·二进制帧路径（data.bytes）",
    ai_remote._b64({"ok": True, "data": {"bytes": b"abc"}}) == b"abc")
chk("分片·旧 base64 路径",
    ai_remote._b64({"ok": True, "data": {"b64": base64.b64encode(b"xyz").decode()}}) == b"xyz")
chk("分片·坏 base64 不炸（b64decode 宽松模式过滤后为空，历史行为不变）",
    ai_remote._b64({"ok": True, "data": {"b64": "!!!"}}) in (None, b""))
chk("分片·失败回执回 None", ai_remote._b64({"ok": False, "data": {"bytes": b"a"}}) is None)

print(f"\n{ok} PASS / {fail} FAIL")
sys.exit(1 if fail else 0)
