# -*- coding: utf-8 -*-
"""Regression checks for public module contracts."""
import asyncio
import os
import sys

DB = os.path.abspath(".smoke-agent-model.db")
for suffix in ("", "-shm", "-wal"):
    try:
        os.remove(DB + suffix)
    except FileNotFoundError:
        pass
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + DB.replace("\\", "/")
sys.path.insert(0, ".")

from app import models  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.services import ai_exec_route, model_catalog  # noqa: E402

ok = fail = 0
lines = []


def chk(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        lines.append("  PASS  " + name)
    else:
        fail += 1
        lines.append("  FAIL  " + name + ("  << " + str(extra)[:200] if extra else ""))


async def main():
    await init_db()
    async with SessionLocal() as s:
        p = models.ModelProvider(id="gw", name="共享模型服务", base_url="http://gw.local/v1",
                                 api_key="org-key", enabled=True, kind="openai-compat")
        s.add(p)
        for nm in ("fast-small", "big-strong", "mid", "dev-coding-large-agent-soduwork"):
            s.add(models.ModelDef(id="gw:" + nm, provider_id="gw", name=nm, label=nm, enabled=True))
        box = models.Client(id="c-am", name="指定模型冒烟")
        s.add(box)
        await s.commit()
        await s.refresh(box)

        # Unspecified runtime preference follows the client default.
        base = (await model_catalog.resolve_for_agent(s, box, "pi")).get("model")
        chk("没指定时跟这台 SoduWork 的默认", base == "fast-small", base)

        # Configure Pi's preferred model.
        box.agent_models = {"pi": "big-strong"}
        await s.commit()
        got = await model_catalog.resolve_for_agent(s, box, "pi")
        chk("★指定之后派活就按它走", got.get("model") == "big-strong", got.get("model"))
        chk("没被指定的底座不受影响",
            (await model_catalog.resolve_for_agent(s, box, "opencode")).get("model") == "fast-small")
        chk("解析出来的地址与密钥仍是这个人真正生效的那套",
            got.get("base") == "http://gw.local/v1" and got.get("key") == "org-key", got)

        # An explicit per-turn model overrides the runtime preference.
        over = await model_catalog.resolve_for_agent(s, box, "pi", override="mid")
        chk("★里程碑这一环指定的仍然最大", over.get("model") == "mid", over.get("model"))
        renamed = await model_catalog.resolve_for_agent(
            s, box, "pi", override="dev-coding-large-agent-hugengyong")
        chk("旧模型名仍兼容执行但实际使用 SoduWork 新名",
            renamed.get("model") == "dev-coding-large-agent-soduwork", renamed)

        # Persisted preferences need the same compatibility path as explicit overrides.
        box.agent_models = {"pi": "dev-coding-large-agent-hugengyong"}
        await s.commit()
        preferred = await model_catalog.resolve_for_agent(s, box, "pi")
        chk("Stored legacy preference executes the current model without fallback",
            preferred.get("model") == "dev-coding-large-agent-soduwork"
            and "fellBackFrom" not in preferred, preferred)
        await s.refresh(box)
        chk("Resolving an alias does not rewrite the stored preference",
            box.agent_models == {"pi": "dev-coding-large-agent-hugengyong"})

        # Runtime preferences remain independent of machine identity.
        chk("★同一个底座在别的机器上也认这份指定",
            ai_exec_route.cli_of("runner:rn-trial:pi") == ai_exec_route.cli_of("local:pi") == "pi")
        chk("收件人 id 认不出底座时回空串（按「没指定」处理）",
            ai_exec_route.cli_of("") == "" and ai_exec_route.cli_of("bogus") == "")

        # Explain fallback when the stored preference is no longer usable.
        box.agent_models = {"pi": "已经没有这个模型了"}
        await s.commit()
        gone = await model_catalog.resolve_for_agent(s, box, "pi")
        chk("★★用不了时退回默认（不能整个派不出去）", gone.get("model") == "fast-small", gone)
        chk("★★而且必须说清是从哪个退回来的（静默换模型比报错更糟）",
            gone.get("fellBackFrom") == "已经没有这个模型了", gone)
        chk("正常命中时不带这个标记", "fellBackFrom" not in over, over)

        # Provider disabling invalidates every model using that provider.
        box.agent_models = {"pi": "big-strong"}
        p.enabled = False
        await s.commit()
        dead = await model_catalog.resolve_for_agent(s, box, "pi")
        chk("★provider 被停用后一个都解析不出（调用方按「模型没配好」处理）", dead == {}, dead)

        # Verify the serialized preference shape.
        p.enabled = True
        box.agent_models = {"pi": "big-strong", "opencode": "mid"}
        await s.commit()
        chk("agent_model() 读得回来",
            model_catalog.agent_model(box, "pi") == "big-strong"
            and model_catalog.agent_model(box, "opencode") == "mid"
            and model_catalog.agent_model(box, "claude") == "")
        chk("大小写/空白不算数", model_catalog.agent_model(box, " PI ") == "big-strong")

    print("\n".join(lines))
    print("\nagent model smoke: %d passed, %d failed" % (ok, fail))
    return 1 if fail else 0


sys.exit(asyncio.run(main()))
