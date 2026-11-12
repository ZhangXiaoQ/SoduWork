# -*- coding: utf-8 -*-
"""Live agent setup smoke tests covering detection, version jobs, and positive/negative probes.
Require a response marker absent from the prompt and a deliberately failing provider. Use
isolated test records and restore Pi configuration bytes in every exit path; run from
hub-backend.
"""
import asyncio
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, ".")

from sqlalchemy import select  # noqa: E402

from app import models  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.services import agent_setup as A  # noqa: E402
from app.services import cli_account_auth as C  # noqa: E402
from live_test_support import seed_active_device  # noqa: E402

ok = fail = 0
log = []
BASE = os.environ.get("SMOKE_BASE", "http://127.0.0.1:9080").rstrip("/") + "/api/v1"
CID = "u-smoke-agents"
DEVICE_SECRET = "smoke-agents-device-secret-0123456789abcdef"
PID = "smoke-agent-provider"
PI_CFG = os.path.join(os.path.expanduser("~"), ".pi", "agent", "models.json")
OFFLINE = os.environ.get("SODUWORK_SMOKE_OFFLINE") == "1"
try:
    with open(PI_CFG, "rb") as _f:
        PI_CFG_BEFORE = _f.read()
except FileNotFoundError:
    PI_CFG_BEFORE = None


def restore_pi_cfg():
    """Restore the exact original configuration bytes after probes, whether they succeed or fail."""
    if PI_CFG_BEFORE is None:
        try:
            os.remove(PI_CFG)
        except FileNotFoundError:
            pass
        return
    os.makedirs(os.path.dirname(PI_CFG), exist_ok=True)
    with open(PI_CFG, "wb") as f:
        f.write(PI_CFG_BEFORE)


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        log.append("  PASS  " + name)
    else:
        fail += 1
        log.append("  FAIL  " + name + ("  << " + str(extra)[:300] if extra else ""))


def call(method, path, body=None, device=None, timeout=40):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if device:
        req.add_header("X-Soduwork-Device", device)
        req.add_header("X-Soduwork-Secret", DEVICE_SECRET)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def wait_job(jid, device, limit=200):
    """Poll jobs through the running Hub's HTTP API so execution belongs to the real backend
    process, not this short-lived test process.
    """
    t0 = time.time()
    while time.time() - t0 < limit:
        st, j = call("GET", "/agent-setup/job/" + jid, device=device)
        if st != 200:
            return {"state": "gone", "ok": False, "detail": "作业查不到 %s" % st}
        if j.get("state") == "done":
            return j
        time.sleep(1.0)
    return {"state": "timeout", "ok": False, "detail": "超过 %ds 没结束" % limit}


async def purge():
    async with SessionLocal() as s:
        for m in (await s.execute(select(models.ModelDef).where(
                models.ModelDef.provider_id == PID))).scalars().all():
            await s.delete(m)
        p = await s.get(models.ModelProvider, PID)
        if p is not None:
            await s.delete(p)
        c = await s.get(models.Client, CID)
        if c is not None:
            await s.delete(c)
        await s.commit()


async def main():
    await purge()
    async with SessionLocal() as s:
        await seed_active_device(
            s, CID, DEVICE_SECRET, name="（冒烟）Agent 探测",
            platform="live-smoke", app_version="live-gate")
        await s.commit()

    # Verify the probe marker cannot be satisfied by prompt echo.
    chk("★★探活口令**不是**提示词的子串（CLI 回显用户消息也蒙不过去）",
        A._TOKEN not in A._PROMPT, {"token": A._TOKEN, "prompt": A._PROMPT[:120]})
    chk("提示词里确实给了拼起来的两段",
        A._TOK_A in A._PROMPT and A._TOK_B in A._PROMPT)
    probe_args = A._probe_args("pi", ["-p"])
    chk("Pi 探活不落会话、不加载扩展，也不给任何工具",
        all(x in probe_args for x in ("--no-session", "--no-tools", "--no-extensions",
                                      "--no-skills", "--no-context-files")), probe_args)

    # Verify actionable translation of captured real CLI diagnostics.
    # Prioritize explicit authentication failure over unrelated numeric substrings.
    # A UUID may coincidentally contain an HTTP-like number.
    # That must not produce a misleading endpoint or model error.
    account_cli_out = ('{"session_id":"404a1cf8-c54b","error":"authentication_failed"}\n'
                  '{"is_error":true,"result":"Not logged in · Please run /login"}')
    chk("★★没登录被说成「没登录」，不会被输出里碰巧的 404 带偏",
        "登录" in A._why_failed(account_cli_out, 0) and "地址" not in A._why_failed(account_cli_out, 0),
        A._why_failed(account_cli_out, 0))
    chk("★密钥不对说得出是密钥不对",
        "密钥" in A._why_failed('{"finalError":"401 status code (no body)"}', 0))
    chk("★连不上说得出是连不上",
        "连不上" in A._why_failed('{"finalError":"Connection error."}', 0))
    chk("★失败原因里不带自相矛盾的「退出码 0」（认证失败时退出码常常就是 0）",
        "退出码" not in A._why_failed('{"finalError":"401 status code (no body)"}', 0),
        A._why_failed('{"finalError":"401 status code (no body)"}', 0))
    chk("实在认不出来时才兜底带上退出码", "退出码" in A._why_failed("", 3))

    codex_logged_in = C.probe(
        "codex", "codex", runner=lambda _exe, _args: (0, "Logged in using ChatGPT"))
    chk("Codex 已登录状态能准确识别", codex_logged_in[0] == "authed", codex_logged_in)
    fallback = C.probe("codex", "codex", runner=lambda _exe, _args: None)
    chk("旧版 CLI 不支持状态命令时保留兼容兜底", fallback == ("", ""), fallback)

    # Probe runtime discovery.
    st, r = call("GET", "/agent-setup", device=CID)
    chk("GET /agent-setup 通（首见自动注册这台 SoduWork）", st == 200, (st, str(r)[:150]))
    keys = {a["key"] for a in r.get("agents", [])}
    chk("★三个 agent 都列出来了（没装的也要列，否则这一页等于没用）",
        {"opencode", "pi", "codex"} <= keys, sorted(keys))
    chk("前提条件（node/npm）说得出来", bool(r["env"]["node"] and r["env"]["npm"]), r["env"])
    chk("说得出活在哪台机器上跑", bool(r["env"]["host"]), r["env"])
    by = {a["key"]: a for a in r["agents"]}
    for a in r["agents"]:
        chk("「%s」每一档都有一句人话" % a["key"], bool(a["why"]), a)
        if a["installed"]:
            chk("「%s」装了就报得出版本（package.json 没了也要问得出来）" % a["key"],
                bool(a["version"]), a)
            chk("「%s」说得出可执行文件在哪儿" % a["key"], bool(a["bin"]), a)
    chk("★pi 要额外给出真身入口（它的 bin 是 node，只显示 node.exe 会让人以为装错了）",
        (not by["pi"]["installed"]) or by["pi"]["entry"].endswith("cli.js"), by["pi"])
    chk("★Codex 不吃 SoduWork 的模型（needsLlm=false，所以没模型也不该拦它）",
        by["codex"]["needsLlm"] is False, by["codex"])
    chk("界面上不许出现 markdown 记号（这些字段是直接进 HTML 的）",
        not any(("**" in (a.get(k) or "")) for a in r["agents"]
                for k in ("why", "blurb", "configHow", "warn", "warnNow")),
        [a["key"] for a in r["agents"]])

    # ---- Installed CLIs still require a usable model; the two dependent agents must report nollm. ----
    # This fixture has no credentials; skip this check if an organization key configures the shared model service.
    if r["modelCount"] == 0:
        chk("★没有可用模型时，要模型的 agent 报「还差模型」而不是「可以派活」",
            all(by[key]["state"] == ("nollm" if by[key]["installed"] else "missing")
                for key in ("pi", "opencode")),
            {k: by[k]["state"] for k in ("pi", "opencode")})
        chk("★而不要模型的 Codex 只受自身登录态影响",
            by["codex"]["state"] in ("ready", "unauthed", "missing"),
            by["codex"])
    else:
        log.append("  SKIP  「还差模型」那一档（这台机器上组织已经配了 key，构造不出来）")

    # Check latest versions through the real registry without changing installed software.
    if OFFLINE:
        log.append("  SKIP  查新版真调用（SODUWORK_SMOKE_OFFLINE=1）")
    else:
        st, r2 = call("POST", "/agent-setup/install", {"key": "pi", "action": "check"}, device=CID)
        chk("发起「查新版」作业通", st == 200 and r2.get("jobId"), (st, r2))
        j = wait_job(r2.get("jobId", ""), CID, limit=150)
        chk("★查新版作业跑完并给了结论", j.get("state") == "done" and j.get("ok") is True, j.get("detail"))
        chk("★作业日志是**边跑边给**的（命令行 + 输出都在）",
            any("npm" in ln for ln in j.get("lines", [])), j.get("lines", [])[:4])

    st, _ = call("POST", "/agent-setup/install", {"key": "nope", "action": "check"}, device=CID)
    chk("不认识的 agent 被拦住", st == 404, st)
    st, _ = call("POST", "/agent-setup/install", {"key": "pi", "action": "rm -rf"}, device=CID)
    chk("不认识的操作被拦住", st == 400, st)
    st, _ = call("GET", "/agent-setup/job/deadbeef", device=CID)
    chk("查不存在的作业回 404", st == 404, st)

    # An unreachable test gateway must fail with an actionable probe result.
    async with SessionLocal() as s:
        s.add(models.ModelProvider(id=PID, name="（冒烟）假网关", kind="openai-compat",
                                   base_url="https://smoke-no-such-host.invalid/v1",
                                   api_key="smoke-bad-key", builtin=False, enabled=True))
        s.add(models.ModelDef(id=PID + ":smoke-bad-model", provider_id=PID,
                              name="smoke-bad-model", label="冒烟坏模型",
                              builtin=False, enabled=True))
        await s.commit()
    st, r3 = call("POST", "/agent-setup/probe", {"key": "pi", "model": "smoke-bad-model"},
                  device=CID)
    chk("发起探活作业通", st == 200 and r3.get("jobId"), (st, r3))
    chk("★探活用的是解析出来的那个模型（和派活同一条路径）",
        r3.get("model") == "smoke-bad-model", r3)
    jb = wait_job(r3.get("jobId", ""), CID, limit=200)
    if by["pi"]["installed"]:
        chk("★★网关不存在时，探活必须报「不通」（不是绿灯）", jb.get("ok") is False, jb.get("detail"))
        chk("★失败要给人话，不只是个退出码",
            bool(jb.get("detail")) and jb["detail"] not in ("", "None") and
            not jb["detail"].strip().isdigit(), jb.get("detail"))
    else:
        chk("未安装 Pi 时探活明确提示先安装", jb.get("ok") is False and bool(jb.get("detail")),
            jb.get("detail"))
        log.append("  SKIP  假网关真调用（这台机器没有 Pi，不能把『未安装』误算成网关测试通过）")

    # A configured organization model must complete the positive probe.
    async with SessionLocal() as s:
        c = await s.get(models.Client, CID)
        comp = await s.get(models.ModelProvider, "company")
        has_real = bool(comp and comp.enabled and comp.base_url and comp.api_key)
    if has_real and by["pi"]["installed"] and not OFFLINE:
        st, r4 = call("POST", "/agent-setup/probe", {"key": "pi"}, device=CID)
        jg = wait_job(r4.get("jobId", ""), CID, limit=240)
        chk("★★探活正例：pi 真跑了一轮、把口令拼对了", jg.get("ok") is True, jg.get("detail"))
        chk("★pi 的逐字 delta 没有刷进人看的日志（它每个字都重发整条快照）",
            not any('"type":"message_update"' in ln for ln in jg.get("lines", [])),
            len(jg.get("lines", [])))
        # Persist probe results across page reloads.
        st, r5 = call("GET", "/agent-setup", device=CID)
        pi = next(a for a in r5["agents"] if a["key"] == "pi")
        chk("★探活结果记住了（后端重启也还在）",
            pi["probe"].get("ok") is True and pi["probe"].get("at"), pi.get("probe"))
        chk("★两步都记下来了（装没装 / 能不能干活分开说）",
            len(pi["probe"].get("steps") or []) == 2, pi.get("probe"))
    else:
        reason = "SODUWORK_SMOKE_OFFLINE=1" if OFFLINE else "公司网关未配置，或这台机器没有安装 Pi"
        log.append("  SKIP  探活正例（%s）" % reason)

    # Remove test records and restore Pi configuration.
    await purge()
    restore_pi_cfg()
    cfg = {}
    try:
        with io.open(PI_CFG, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:  # noqa: BLE001
        pass
    base_now = ((cfg.get("providers") or {}).get("company") or {}).get("baseUrl", "")
    chk("★★冒烟没给真实派活留下一个指向假网关的 pi 配置",
        "smoke-no-such-host" not in base_now and (
            (not os.path.exists(PI_CFG) and PI_CFG_BEFORE is None)
            or (PI_CFG_BEFORE is not None and open(PI_CFG, "rb").read() == PI_CFG_BEFORE)),
        base_now)
    chk("★pi 的配置里**不许有明文密钥**（只能是变量引用）",
        not ((cfg.get("providers") or {}).get("company") or {}).get("apiKey", "") or
        str(((cfg.get("providers") or {}).get("company") or {}).get("apiKey", "")).startswith("$"),
        ((cfg.get("providers") or {}).get("company") or {}).get("apiKey", ""))
    async with SessionLocal() as s:
        chk("★冒烟 provider 已删干净", await s.get(models.ModelProvider, PID) is None)
        chk("★冒烟 SoduWork 也删了", await s.get(models.Client, CID) is None)
        c2 = await s.get(models.Client, "u-smoke-agents-reset")
        if c2 is not None:
            await s.delete(c2)
            await s.commit()
        chk("★复位用的那台临时 SoduWork 也删了",
            await s.get(models.Client, "u-smoke-agents-reset") is None)


try:
    asyncio.run(main())
finally:
    asyncio.run(purge())
    restore_pi_cfg()
log.append("")
log.append("PASS=%d FAIL=%d" % (ok, fail))
with io.open("smoke_agents.out.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(log))
print("PASS=%d FAIL=%d" % (ok, fail))
sys.exit(1 if fail else 0)
