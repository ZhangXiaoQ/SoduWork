"""Regression coverage for ACP registration, Codex Harness isolation, missing-model checks, and
team visibility.
"""
from __future__ import annotations
import json, os, sys
import tempfile
from pathlib import Path
_fixture = tempfile.TemporaryDirectory(prefix="soduwork-smoke-acp-team-")
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///" + (Path(_fixture.name) / ".smoke.db").as_posix()
sys.path.insert(0, ".")
from app.services import acp_agents, agent_setup, dsh_gateway  # noqa: E402
from app.services.local_base import _PROFILES, _env_for  # noqa: E402

passed = failed = 0
def ok(cond, name, detail=""):
    global passed, failed
    if cond: passed += 1; print("  PASS ", name)
    else: failed += 1; print("  FAIL ", name, " << ", str(detail)[:220])

def main() -> int:
    # Register DeepSeek Harness with discovery, installation, and model injection.
    ok("dsh" in acp_agents.CATALOG and acp_agents.CATALOG["dsh"]["pkg"] == "@openma/deepseek-harness-acp",
       "dsh 在 ACP 目录里且指向官方生态适配包")
    ok("dsh" in _PROFILES and _PROFILES["dsh"].get("acp_key") == "dsh",
       "dsh 自动汇入底座注册表（local:dsh 可派活）")
    env = {"DEEPSEEK_API_KEY": "native-key", "DEEPSEEK_BASE_URL": "https://native.invalid"}
    acp_agents.inject_llm_env("dsh", env, {"base": "http://gw/v1", "key": "sk-x", "model": "deepseek-chat"})
    profile = json.loads(env.get(dsh_gateway.PROFILE_ENV) or "{}").get(dsh_gateway.PROVIDER, {})
    ok(profile.get("baseURL") == "http://gw/v1" and profile.get("api") == "openai-completions"
       and profile.get("apiKeyEnv") == dsh_gateway.KEY_ENV and env.get(dsh_gateway.KEY_ENV) == "sk-x"
       and env.get("DSH_MODEL") == "deepseek-chat" and env.get("DSH_PROVIDER") == dsh_gateway.PROVIDER
       and "sk-x" not in env.get(dsh_gateway.PROFILE_ENV, "")
       and "DEEPSEEK_API_KEY" not in env and "DEEPSEEK_BASE_URL" not in env,
       "dsh 企业模型通过 provider 配置路由且不复用原生 DeepSeek 搜索凭据")
    # Keep Codex Harness separate, passing organization credentials through subprocess environment and isolating its home.
    ok("codex-harness" in acp_agents.CATALOG
       and acp_agents.CATALOG["codex-harness"]["pkg"] == "@agentclientprotocol/codex-acp",
       "Codex Harness 指向官方 ACP 适配包")
    ok("codex-harness" in _PROFILES
       and _PROFILES["codex-harness"].get("acp_key") == "codex-harness",
       "Codex Harness 自动汇入底座注册表（local:codex-harness 可派活）")
    codex_env = {}
    acp_agents.inject_llm_env("codex-harness", codex_env, {
        "base": "http://gw/v1", "key": "sk-enterprise", "model": "coding-v1"},
        mode="plan")
    auth = json.loads(codex_env.get("DEFAULT_AUTH_REQUEST") or "{}")
    config = json.loads(codex_env.get("CODEX_CONFIG") or "{}")
    ok(auth.get("methodId") == "gateway"
       and auth.get("_meta", {}).get("gateway", {}).get("baseUrl") == "http://gw/v1"
       and auth.get("_meta", {}).get("gateway", {}).get("headers", {}).get("Authorization")
       == "Bearer sk-enterprise",
       "Codex Harness 用 ACP gateway auth 注入企业网关", auth)
    ok(config.get("model") == "coding-v1"
       and config.get("model_provider") == "custom-gateway"
       and "sk-enterprise" not in codex_env.get("CODEX_CONFIG", "")
       and codex_env.get("INITIAL_AGENT_MODE") == "read-only"
       and codex_env.get("NO_BROWSER") == "1",
       "Codex Harness 模型配置无密钥且计划模式只读", codex_env)
    home_env = {}
    acp_agents.home_env("codex-harness", home_env, ".")
    ok(home_env.get("CODEX_HOME", "").endswith(".codex-harness"),
       "Codex Harness 使用隔离 CODEX_HOME", home_env)
    cfg = {}
    acp_agents.run_args("sid", "plan", ".", cfg)
    ok(cfg.get("_soduwork_agent_mode") == "plan", "ACP 启动权限传到子进程环境", cfg)
    native_name = agent_setup._codex_native_name()
    native_spec = agent_setup._codex_native_spec("0.149.0")
    ok(native_name.startswith("@openai/codex-")
       and native_spec.startswith(native_name + "@npm:@openai/codex@0.149.0-"),
       "Codex Harness 安装器按操作系统与 CPU 选择官方执行包", native_spec)
    ok(agent_setup._runtime_issue("pi") == "",
       "平台执行包完整性检查只作用于 Codex Harness")
    ok(agent_setup._codex_native_matches("0.148.0", "0.148.0-win32-x64"),
       "同版本 Codex 与平台执行包可以配对")
    ok(not agent_setup._codex_native_matches("0.148.0", "0.147.0-win32-x64"),
       "旧个人 Codex 平台包不能冒充适配器的新依赖")
    ok(not ({"goose", "openhands"} & set(acp_agents.CATALOG)),
       "Goose 与 OpenHands 已从底座目录退役")
    # ACP runtimes must report missing model configuration clearly before starting.
    try:
        _env_for(_PROFILES["qwen"], {"llm": {}})
        ok(False, "qwen 无模型配置被拦下")
    except RuntimeError as e:
        ok("模型服务" in str(e) and "Qwen" in str(e), "qwen 无模型配置被拦下且指路", e)
    # Non-ACP runtimes retain their existing configuration path.
    try:
        _env_for(_PROFILES["pi"], {"llm": {}})
        ok(True, "非 ACP 底座无模型配置不在此处拦")
    except Exception as e:
        ok(False, "非 ACP 底座无模型配置不在此处拦", e)
    # Team visibility defaults to managers, permits everyone, and normalizes invalid values.
    import asyncio
    from app.db import SessionLocal, init_db
    from app.services import team as team_svc
    async def scope_check():
        await init_db()
        async with SessionLocal() as s:
            ok(await team_svc.team_module_scope(s) == "managers", "默认口径=负责人及以上")
            ok(await team_svc.set_team_module_scope(s, "everyone") == "everyone", "可放宽为全员")
            ok(await team_svc.team_module_scope(s) == "everyone", "放宽后读取一致")
            ok(await team_svc.set_team_module_scope(s, "banana") == "managers", "非法值回落 managers")
    asyncio.run(scope_check())
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
