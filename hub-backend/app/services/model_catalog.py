"""Administrator-owned models, provider settings, and personal overrides.

Startup only adds missing credential-free provider templates. Historical presets and explicit
migration helpers below never run automatically. Resolve credentials only when preparing
execution and expose masked state to catalog readers.
"""
from __future__ import annotations

import json
import logging

from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import models
from . import model_config_guard, context_window, model_capabilities
from .vision_policy import adapter_configured
from .model_definition_contracts import (
    MODEL_MODALITIES,
    MEDIA_ENDPOINTS,
    IMAGE_ROUTINGS,
    THINKING_MODES,
    THINKING_FORMATS,
    THINKING_LEVELS,
    normalize_modality,
    normalize_image_routing,
    _clean_relative_path,
    _clean_thinking_config,
    clean_model_config,
    model_config,
)

log = logging.getLogger("uvicorn.error")

COMPANY = "company"

# Normalize former organization-model aliases to the current product name.
# Accept old names for compatibility without offering them in new dispatch selectors.
MODEL_ALIASES = {
    "dev-coding-large-agent-hugengyong": "dev-coding-large-agent-soduwork",
}
MODEL_RENAME_FLAG = "model_rename_company_soduwork_20260824"
MEDIA_MODEL_ALIASES = {
    "doubao-seedance-1-0-pro-250528": "doubao-seedance-2-0",
}
MEDIA_MODEL_RENAME_FLAG = "model_rename_seedance_2_0_20260911"
MEDIA_MODEL_CONFIG_FIX_FLAG = "model_config_seedance_2_0_20260920"
FLASH_THINKING_UPGRADE_FLAG = "model_thinking_glm53_flash_controllable_20261022"



def canonical_model_name(value: str) -> str:
    name = str(value or "").strip()
    name = MODEL_ALIASES.get(name, name)
    return MEDIA_MODEL_ALIASES.get(name, name)

# Provider templates are the only catalog rows startup may add.
# Never include API keys in built-in provider definitions.
# Leave the company endpoint unset until an administrator configures it.
BUILTIN_PROVIDERS: list[dict] = [
    {"id": COMPANY, "name": "共享模型服务", "kind": "openai-compat", "base_url": "",
     "note": "自建的 OpenAI 兼容模型服务。地址与密钥由管理员配置，按授权共享。"},
    {"id": "openai-compat", "name": "OpenAI 兼容（通用）", "kind": "openai-compat", "base_url": "",
     "note": "任何 OpenAI 兼容接口都走这一档：自建网关 / vLLM / Ollama / 第三方中转。填地址+key 即可用。"},
    {"id": "volcengine", "name": "字节跳动 · 火山引擎方舟", "kind": "openai-compat",
     "base_url": "https://ark.cn-beijing.volces.com/api/v3",
     "note": "豆包、Seedream 与 Seedance。填写方舟 API Key；如控制台要求使用接入点，请将 ep- 开头的接入点 ID 作为模型 ID。"},
    {"id": "deepseek", "name": "DeepSeek", "kind": "openai-compat",
     "base_url": "https://api.deepseek.com/v1", "note": "深度求索。填自己的 API Key 即可用。"},
    {"id": "aliyun", "name": "阿里云百炼（通义）", "kind": "openai-compat",
     "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "note": "通义千问系列，OpenAI 兼容模式。"},
    {"id": "zhipu", "name": "智谱 GLM", "kind": "openai-compat",
     "base_url": "https://open.bigmodel.cn/api/paas/v4", "note": "智谱 AI 开放平台。"},
    {"id": "moonshot", "name": "月之暗面 Kimi", "kind": "openai-compat",
     "base_url": "https://api.moonshot.cn/v1", "note": "Moonshot AI。"},
    {"id": "openai", "name": "OpenAI", "kind": "openai-compat",
     "base_url": "https://api.openai.com/v1", "note": "官方接口。按需配置凭据并启用。"},
    {"id": "anthropic", "name": "Anthropic Claude", "kind": "anthropic",
     "base_url": "https://api.anthropic.com", "note": "官方接口。按需配置凭据并启用。"},
    {"id": "google", "name": "Google Gemini", "kind": "openai-compat",
     "base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "note": "Gemini 的 OpenAI 兼容端点。"},
]

# Historical presets support explicit migration helpers and their protocol regressions.
# They are not an initialization list; startup never creates or repairs model rows.
# Historical verification is recorded in docs/development/builtin-model-catalog.md.
def _always_thinking_config(format: str) -> dict:
    return {"thinkingMode": "always", "thinkingFormat": format,
            "supportsReasoningEffort": True,
            "thinkingLevelMap": {"off": None, "minimal": None, "low": "low",
                                 "medium": None, "high": "high", "xhigh": None, "max": "max"}}


def _controllable_thinking_config(format: str) -> dict:
    """Allow the session to disable thinking using the provider's format.

    Pi's zai format sends thinking.type=disabled for the off setting.
    Explicit administrator configuration remains authoritative.
    """
    return {"thinkingMode": "controllable", "thinkingFormat": format,
            "supportsReasoningEffort": True,
            "thinkingLevelMap": {"minimal": None, "low": "low",
                                 "medium": None, "high": "high",
                                 "xhigh": None, "max": "max"}}


BUILTIN_MODELS: list[dict] = [
    {"provider_id": "volcengine", "name": "doubao-seed-1-6-250615",
     "label": "豆包 Seed 1.6"},
    {"provider_id": "volcengine", "name": "doubao-seedream-4-0-250828",
     "label": "Seedream 4.0", "modality": "image",
     "config": {"endpointPath": "/images/generations", "defaults": {}}},
    {"provider_id": "volcengine", "name": "doubao-seedance-2-0",
     "label": "Seedance 2.0", "modality": "video",
     "config": {"endpointPath": "/contents/generations/tasks",
                "statusPath": "/contents/generations/tasks/{id}",
                "defaults": {}}},
    {"provider_id": "deepseek", "name": "deepseek-flash", "label": "DeepSeek Flash（快而省，支持视觉）"},
    {"provider_id": "deepseek", "name": "deepseek-v4-pro", "label": "DeepSeek V4 Pro"},
    {"provider_id": "aliyun", "name": "qwen3.8-max", "label": "通义千问 3.8 Max"},
    {"provider_id": "aliyun", "name": "qwen3.8-flash", "label": "通义千问 3.8 Flash（快而省）"},
    {"provider_id": "zhipu", "name": "glm-5.3", "label": "GLM-5.3",
     "config": _always_thinking_config("zai")},
    {"provider_id": "zhipu", "name": "glm-5.3-flash", "label": "GLM-5.3 Flash（快而省）",
     "config": _controllable_thinking_config("zai")},
    {"provider_id": "moonshot", "name": "kimi-k3", "label": "Kimi K3",
     "config": _always_thinking_config("openai")},
    # GPT-6.1 Sol requires Responses for tools. Pi uses Chat Completions and
    # ai_proxy forwards protocols unchanged, so do not seed it for all agents.
    {"provider_id": "openai", "name": "gpt-5.6", "label": "GPT-5.6"},
    {"provider_id": "openai", "name": "gpt-image-1", "label": "GPT Image 1",
     "modality": "image",
     "config": {"endpointPath": "/images/generations", "defaults": {}}},
    {"provider_id": "anthropic", "name": "claude-opus-5-5", "label": "Claude Opus 5.5"},
    {"provider_id": "anthropic", "name": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5"},
    {"provider_id": "google", "name": "gemini-4-argon", "label": "Gemini 4 Argon"},
    {"provider_id": "google", "name": "gemini-3.8-flash", "label": "Gemini 3.8 Flash"},
]


async def _migrate_model_renames(
        session: AsyncSession,
        renames: list[tuple[str, str, str]],
        marker: str) -> int:
    """One-time catalog rename without rewriting immutable execution history.

    Current preferences and pending milestone overrides follow the new name. Old
    published plugin snapshots and historic execution records remain auditable;
    runtime alias resolution keeps those snapshots executable.
    """
    if await session.get(models.AppSetting, marker) is not None:
        return 0
    changed = 0
    clients = list((await session.execute(select(models.Client))).scalars().all())
    for provider_id, old_name, new_name in renames:
        old_id, new_id = provider_id + ":" + old_name, provider_id + ":" + new_name
        old_row = await session.get(models.ModelDef, old_id)
        new_row = await session.get(models.ModelDef, new_id)
        if old_row is not None and new_row is None:
            new_row = models.ModelDef(
                id=new_id, provider_id=provider_id, name=new_name,
                label=new_name if (old_row.label or old_name) == old_name
                else str(old_row.label or old_name).replace(old_name, new_name),
                builtin=bool(old_row.builtin), enabled=True,
                ctx_window=int(old_row.ctx_window or 0),
                modality=normalize_modality(getattr(old_row, "modality", "chat")),
                config=model_config(getattr(old_row, "config", {}),
                                    getattr(old_row, "modality", "chat")),
                note=old_row.note or "",
            )
            session.add(new_row)
            await session.flush()
            changed += 1
        if old_row is not None and old_row.enabled:
            old_row.enabled = False
            changed += 1

        default_row = await session.get(models.AppSetting, "llm_model")
        if default_row is not None and str(default_row.value or "").strip() == old_name:
            default_row.value = new_name
            changed += 1
        choices_row = await session.get(models.AppSetting, "llm_models")
        if choices_row is not None:
            try:
                values = json.loads(choices_row.value or "[]")
            except (TypeError, ValueError):
                values = []
            if isinstance(values, list) and old_name in values:
                replaced = [new_name if item == old_name else item for item in values]
                choices_row.value = json.dumps(list(dict.fromkeys(replaced)), ensure_ascii=False)
                changed += 1

        for client in clients:
            agent_models = dict(client.agent_models or {})
            if old_name in agent_models.values():
                client.agent_models = {
                    key: new_name if value == old_name else value
                    for key, value in agent_models.items()
                }
                changed += 1
            personal_models = list(client.models or [])
            rewritten = []
            personal_changed = False
            for item in personal_models:
                row = dict(item) if isinstance(item, dict) else item
                if (isinstance(row, dict) and row.get("providerId") == provider_id
                        and row.get("name") == old_name):
                    row["name"] = new_name
                    if row.get("label") == old_name:
                        row["label"] = new_name
                    personal_changed = True
                rewritten.append(row)
            if personal_changed:
                client.models = rewritten
                changed += 1

        milestones = (await session.execute(select(models.Milestone).where(
            models.Milestone.model == old_name,
            models.Milestone.status.notin_(("done", "skipped")),
        ))).scalars().all()
        for milestone in milestones:
            milestone.model = new_name
            changed += 1

    session.add(models.AppSetting(key=marker, value=str(changed)))
    await session.flush()
    return changed


async def _repair_builtin_media_model_config(session: AsyncSession) -> int:
    """Repair the early Seedance row that was seeded with a generic endpoint.

    This runs once and only touches the built-in Volcengine model when its
    configuration is empty, generic, or missing the known Ark status route.
    Explicit custom endpoints remain administrator-owned.
    """
    if await session.get(models.AppSetting, MEDIA_MODEL_CONFIG_FIX_FLAG) is not None:
        return 0
    target = next(
        item for item in BUILTIN_MODELS
        if item["provider_id"] == "volcengine"
        and item["name"] == "doubao-seedance-2-0"
    )
    row = await session.get(
        models.ModelDef, "volcengine:doubao-seedance-2-0")
    changed = 0
    if row is not None and bool(row.builtin):
        raw = dict(getattr(row, "config", None) or {})
        endpoint = str(raw.get("endpointPath") or "")
        status_path = str(raw.get("statusPath") or "")
        known_endpoint = target["config"]["endpointPath"]
        if endpoint in {"", MEDIA_ENDPOINTS["video"]} or (
                endpoint == known_endpoint and not status_path):
            fixed = dict(target["config"])
            fixed["defaults"] = dict(raw.get("defaults") or {})
            row.config = clean_model_config(fixed, "video")
            changed = 1
    session.add(models.AppSetting(
        key=MEDIA_MODEL_CONFIG_FIX_FLAG, value=str(changed)))
    await session.flush()
    return changed


async def _repair_builtin_flash_thinking_config(session: AsyncSession) -> int:
    """One-time upgrade: let GLM-5.3 Flash users turn thinking off.

    The flash model shipped with `_always_thinking_config` (thinkingMode
    "always", `off: null`), which forces every conversation to think even for
    trivial turns.  Both gateways actually honor the zai disable flag, so the
    builtin definition moves to a controllable mode.  Only untouched builtin
    rows are upgraded - an administrator who customized the config keeps
    theirs, exactly like the other repair passes.
    """
    if await session.get(models.AppSetting, FLASH_THINKING_UPGRADE_FLAG) is not None:
        return 0
    changed = 0
    row = await session.get(models.ModelDef, "zhipu:glm-5.3-flash")
    if row is not None and bool(row.builtin):
        raw = dict(getattr(row, "config", None) or {})
        # Match the entire persisted default, not just its thinking mode:
        # administrators may retain "always" while customizing other fields.
        legacy = clean_model_config(_always_thinking_config("zai"), "chat")
        if raw == legacy:
            row.config = clean_model_config(
                _controllable_thinking_config("zai"), "chat")
            changed = 1
    session.add(models.AppSetting(
        key=FLASH_THINKING_UPGRADE_FLAG, value=str(changed)))
    await session.flush()
    return changed


async def bootstrap(session: AsyncSession) -> None:
    """Add missing credential-free provider templates; preserve all administrator-owned data.

    Models start empty and are maintained through the admin API. Legacy defaults must not
    recreate a deleted model, restore provider credentials, or re-enable disabled providers.
    Historical model migrations/repairs are deliberately excluded from ordinary startup.
    """
    have_p = {p.id for p in (await session.execute(select(models.ModelProvider))).scalars().all()}
    changed = False
    for p in BUILTIN_PROVIDERS:
        if p["id"] in have_p:
            continue
        # Built-in services are enabled by default. Permission to use a service is separate from endpoint and credential readiness.
        # Users may supply personal credentials for allowed services even when shared credentials are not configured.
        session.add(models.ModelProvider(builtin=True, enabled=True, **p))
        changed = True
    await session.commit()
    if changed:
        from .client_domain_events import models_changed
        await models_changed(session)


# Catalog reads.
def _p_api(p, *, with_secret: bool = False) -> dict:
    d = {"revision": model_config_guard.revision(p), "id": p.id, "name": p.name, "kind": p.kind, "baseUrl": p.base_url,
         "builtin": bool(p.builtin), "enabled": bool(p.enabled), "note": p.note,
         # Return only key presence and length, never plaintext.
         "keySet": bool(p.api_key), "keyLen": len(p.api_key or "")}
    if with_secret:
        d["apiKey"] = p.api_key
    return d


def _m_api(m) -> dict:
    modality = normalize_modality(getattr(m, "modality", "chat"))
    resolved = context_window.resolve({
        "contextWindow": getattr(m, "ctx_window", 0),
        "modelName": getattr(m, "name", ""),
        "providerId": getattr(m, "provider_id", ""),
    })
    return {"revision": model_config_guard.revision(m), "id": m.id,
            "providerId": m.provider_id, "name": m.name,
            "label": m.label or m.name, "builtin": bool(m.builtin),
            "enabled": bool(m.enabled), "ctxWindow": resolved["contextWindow"],
            "contextWindowKnown": resolved["contextWindowKnown"],
            "contextWindowEstimated": resolved["contextWindowEstimated"],
            "contextWindowSource": resolved["contextWindowSource"],
            "modality": modality,
            "config": model_config(getattr(m, "config", {}), modality),
            "note": m.note}


def _personal_provider_rows(client) -> list[dict]:
    """Return this client's personal model services and organization endpoint overrides."""
    cfg = dict(getattr(client, "config", None) or {}) if client is not None else {}
    rows = cfg.get("modelProviders") or []
    return [dict(x) for x in rows if isinstance(x, dict)]


def _clear_provider_cache(session, _flush_context):
    # Explicit flush clears Session.dirty before a subsequent admission read.
    for key in list(session.info):
        if isinstance(key, tuple) and key[:1] == ("soduwork-effective-providers",):
            session.info.pop(key, None)


async def effective_provider_map(session: AsyncSession, client=None) -> dict[str, dict]:
    """Resolve effective personal services without inheriting organization secrets into personal
    endpoints.
    """
    # One AI request calls usable() and resolve(); both need the same
    # effective provider map. Reuse only within the same unchanged transaction;
    # callers may keep their session after changing or disabling a provider.
    if not event.contains(session.sync_session, "after_flush", _clear_provider_cache):
        event.listen(session.sync_session, "after_flush", _clear_provider_cache)
    request_cache = getattr(session, "info", None)
    client_key = str(getattr(client, "id", "") or (id(client) if client is not None else ""))
    cache_key = ("soduwork-effective-providers", client_key)
    # The underlying transaction is the cache identity. Some supported
    # SQLAlchemy versions cannot reconstruct its async proxy after autobegin;
    # reading the sync identity performs no IO and works for both paths.
    transaction = session.sync_session.get_transaction()
    cached = request_cache.get(cache_key) if isinstance(request_cache, dict) else None
    if (cached is not None and transaction is not None and cached[0] is transaction
            and not (session.dirty or session.new or session.deleted)):
        return cached[1]
    org_rows = (await session.execute(select(models.ModelProvider)
                                     .execution_options(populate_existing=True))).scalars().all()
    personal = _personal_provider_rows(client)
    overrides = {str(x.get("id") or ""): x for x in personal if not x.get("personal")}
    out: dict[str, dict] = {}
    for p in org_rows:
        ov = overrides.get(p.id) or {}
        overridden = bool(str(ov.get("baseUrl") or "").strip())
        base = str(ov.get("baseUrl") or "").strip() if overridden else (p.base_url or "")
        out[p.id] = {
            "id": p.id, "name": p.name, "kind": p.kind or "openai-compat",
            "baseUrl": base, "defaultBaseUrl": p.base_url or "",
            "builtin": bool(p.builtin), "enabled": bool(p.enabled), "note": p.note or "",
            "personal": False, "addressOverridden": overridden, "authMode": "key",
            "apiKey": "" if overridden else (p.api_key or ""),
        }
    for row in personal:
        if not row.get("personal"):
            continue
        pid = str(row.get("id") or "").strip()[:48]
        if not pid or pid in out:
            continue
        out[pid] = {
            "id": pid, "name": str(row.get("name") or "自定义服务")[:64],
            "kind": str(row.get("kind") or "openai-compat")[:24],
            "baseUrl": str(row.get("baseUrl") or "").strip()[:400],
            "defaultBaseUrl": "", "builtin": False, "enabled": True,
            "note": str(row.get("note") or "我的自定义模型服务")[:300],
            "personal": True, "addressOverridden": True,
            "authMode": "none" if row.get("authMode") == "none" else "key", "apiKey": "",
        }
    if isinstance(request_cache, dict):
        request_cache[cache_key] = (session.sync_session.get_transaction(), out)
    return out


async def providers_for_client(session: AsyncSession, client) -> list[dict]:
    """Return the masked service list for clients."""
    mine = dict(getattr(client, "model_keys", None) or {})
    out = []
    for p in (await effective_provider_map(session, client)).values():
        key = str(mine.get(p["id"]) or "").strip()
        out.append({k: v for k, v in p.items() if k != "apiKey"} | {
            "keySet": bool(p.get("apiKey")), "keyLen": len(p.get("apiKey") or ""),
            "myKeySet": bool(key), "myKeyLen": len(key),
        })
    return out


def provider_key(p: dict, client) -> tuple[str, str]:
    if p.get("authMode") == "none":
        # Some compatible SDKs require an API-key field even when the local service ignores authentication.
        return "soduwork-local-no-key", "none"
    mine = dict(getattr(client, "model_keys", None) or {}) if client is not None else {}
    own = str(mine.get(p.get("id")) or "").strip()
    if own:
        return own, "mine"
    org = str(p.get("apiKey") or "")
    return (org, "org") if org else ("", "")


async def catalog(session: AsyncSession, client=None) -> dict:
    """Return the masked model catalog for administration."""
    ps = (await session.execute(select(models.ModelProvider))).scalars().all()
    ms = (await session.execute(select(models.ModelDef))).scalars().all()
    rows = [_m_api(m) for m in ms]
    await model_capabilities.enrich(session, rows, await effective_provider_map(session, client), client)
    return {"providers": [_p_api(p) for p in ps], "models": rows}


async def usable(session: AsyncSession, client=None, modality: str = "chat") -> list[dict]:
    """Return models usable by this client, checking model visibility, enabled provider, endpoint,
    and required credentials. Prefer personal credentials over organization credentials and
    include keyFrom so users can identify whose quota applies.
    """
    wanted = normalize_modality(modality)
    ps = await effective_provider_map(session, client)
    ms = list((await session.execute(select(models.ModelDef))).scalars().all())
    mine_keys = dict(getattr(client, "model_keys", None) or {}) if client is not None else {}
    out: list[dict] = []
    seen = set()
    for m in ms:
        if normalize_modality(getattr(m, "modality", "chat")) != wanted:
            continue
        p = ps.get(m.provider_id)
        if p is None or not p["enabled"] or not p["baseUrl"]:
            continue
        if not m.enabled:
            continue
        _, key_from = provider_key(p, client)
        if not key_from:
            continue
        seen.add((p["id"], m.name))
        out.append({**_m_api(m), "providerName": p["name"], "providerKind": p["kind"],
                    "keyFrom": key_from, "own": False})
    # Include personal models absent from the organization catalog.
    for c in (getattr(client, "models", None) or []) if client is not None else []:
        if not isinstance(c, dict) or normalize_modality(c.get("modality")) != wanted:
            continue
        pid, nm = str(c.get("providerId") or ""), str(c.get("name") or "").strip()
        p = ps.get(pid)
        # Personal models must still respect the provider's enabled state.
        # Disabling a provider applies to all models using it.
        if not nm or p is None or not p["enabled"] or not p["baseUrl"] or (pid, nm) in seen:
            continue
        _, key_from = provider_key(p, client)
        if not key_from:
            continue
        resolved = context_window.resolve({
            "contextWindow": c.get("contextWindow") or c.get("ctxWindow"),
            "modelName": nm, "providerId": pid,
        })
        out.append({"id": pid + ":" + nm, "providerId": pid, "name": nm,
                    "label": str(c.get("label") or nm), "builtin": False, "enabled": True,
                    "ctxWindow": resolved["contextWindow"],
                    "contextWindowKnown": resolved["contextWindowKnown"],
                    "contextWindowEstimated": resolved["contextWindowEstimated"],
                    "contextWindowSource": resolved["contextWindowSource"],
                    "modality": wanted,
                    "config": model_config(c.get("config"), wanted),
                    "note": "我自己加的", "providerName": p["name"], "providerKind": p["kind"],
                    "keyFrom": key_from, "own": True})
    return await model_capabilities.enrich(session, out, ps, client)


async def choices(session: AsyncSession, client=None, preferred: str = "",
                  modality: str = "chat") -> dict:
    """Build picker choices from models that the current device can really use.

    The legacy llm_models value is a free-form string list and can retain removed
    models or old smoke-test names. Dispatch must use the same truth as execution:
    enabled model and provider, a real endpoint, and an effective key.
    """
    rows = await (usable(session, client) if normalize_modality(modality) == "chat"
                  else usable(session, client, modality))
    names: list[str] = []
    seen: set[str] = set()
    for row in rows:
        name = str(row.get("name") or "").strip()
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    preferred = canonical_model_name(preferred)
    default = preferred if preferred in seen else (names[0] if names else "")
    return {
        "default": default,
        "list": [name for name in names if name != default],
        "items": rows,
    }


def probe_sync(base: str, key: str, model: str, kind: str = "openai-compat") -> dict:
    """Test the configured key and return {ok, detail}, with a human-readable detail message.
    
    A model service can reject /v1/models while still accepting chat requests. Try /models first,
    then fall back to a minimal chat request (max_tokens=1). Report safe diagnostics without raw
    provider bodies or credentials. Connect directly to the configured
    model service without inheriting system proxies.
    """
    import json as _json
    import ssl
    import urllib.error
    import urllib.request
    from . import model_errors

    def failure(error):
        status = error.code
        body = error.read(16000).decode("utf-8", "replace")
        billing = model_errors.billing_diagnostic(body)
        detail = (model_errors.billing_message(billing) + f"（HTTP {status}）"
                  if billing else model_errors.public_failure(f"HTTP {status}"))
        return {"ok": False, "detail": detail,
                **(billing or {})}

    def _open(path: str, body: dict | None):
        url = base.rstrip("/") + path
        data = _json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method="POST" if body else "GET")
        if kind == "anthropic":
            req.add_header("x-api-key", key)
            req.add_header("anthropic-version", "2023-06-01")
        else:
            req.add_header("Authorization", "Bearer " + key)
        if body is not None:
            req.add_header("Content-Type", "application/json")
        opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
            urllib.request.ProxyHandler({}),           # Disable proxies with an empty mapping.
        )
        with opener.open(req, timeout=20) as r:
            return r.status, r.read(600).decode("utf-8", "replace")

    if not (base and key):
        return {"ok": False, "detail": "地址或密钥还没配全"}
    try:
        st, _ = _open("/v1/models" if kind == "anthropic" else "/models", None)
        if st == 200:
            return {"ok": True, "probe": "models",
                    "detail": "模型列表可访问；尚未验证聊天生成、余额或当前 Agent 的协议兼容性"}
    except urllib.error.HTTPError as e:
        if e.code not in (401, 403, 404, 405):
            return failure(e)
    except Exception as e:  # noqa: BLE001 - Explain connectivity, timeout, and certificate failures.
        return {"ok": False, "detail": "连接失败，请检查 API 地址、网络和证书"}
    # Fall back to a minimal chat request when model discovery is denied.
    if not model:
        return {"ok": False, "detail": "这家的模型列表接口不给用，又没有可试的模型——先加一个模型再测"}
    try:
        path = "/v1/messages" if kind == "anthropic" else "/chat/completions"
        st, _ = _open(path, {"model": model, "max_tokens": 1,
                            "messages": [{"role": "user", "content": "hi"}]})
        return {"ok": st == 200, "probe": "chat", "detail": "最小聊天请求成功；当前 Agent 的协议兼容性仍需单独确认" if st == 200
                                          else f"HTTP {st}"}
    except urllib.error.HTTPError as e:
        return failure(e)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "detail": "连接失败，请检查 API 地址、网络和证书"}


async def resolve(session: AsyncSession, client, model_name: str = "",
                  modality: str = "chat", *, provider_id: str = "",
                  available: list[dict] | None = None,
                  providers: dict[str, dict] | None = None) -> dict:
    """Resolve the selected model to endpoint, key, and model at dispatch time. Empty selection
    uses the client's default; return empty when resolution fails.
    """
    wanted = normalize_modality(modality)
    # Reuse the admission result when the caller already checked it. Chat
    # requests used to query providers/models once in `usable`, then repeat
    # both queries in `resolve`, adding avoidable round trips to the remote
    # PostgreSQL database before every model request.
    lst = list(available) if available is not None else await usable(session, client, wanted)
    if provider_id:
        lst = [row for row in lst if row["providerId"] == provider_id]
    if not lst:
        return {}
    requested = canonical_model_name(model_name)
    hit = next((m for m in lst if m["name"] == requested), None) if requested else None
    # Fail when an explicitly selected model is unavailable; never silently substitute the first catalog entry.
    # Otherwise revoked credentials could redirect work to an unintended model and invalidate results and audit records.
    if requested and hit is None:
        return {}
    m = hit or lst[0]
    p = (providers if providers is not None else await effective_provider_map(session, client)).get(m["providerId"])
    if p is None:
        return {}
    key, key_from = provider_key(p, client)
    if not (p["baseUrl"] and key):
        return {}
    config = model_config(m.get("config"), wanted)
    resolved_window = context_window.resolve({
        "contextWindow": m.get("ctxWindow"), "modelName": m.get("name"),
        "providerId": m.get("providerId"),
    })
    from . import model_quota
    return {"base": p["baseUrl"], "key": key, "model": m["name"],
            "user": str(getattr(client, "user_ref", None) or getattr(client, "id", "") or "internal"),
            "quotaUserId": str(getattr(client, "user_ref", None) or ""),
            "quotaClientId": str(getattr(client, "id", None) or ""),
            "quotaAuthVersion": int(getattr(client, "auth_version", 1) or 1),
            "fundingScope": model_quota.scope(p, key_from), "quotaScope": "platform",
            "provider": p["id"], "kind": p["kind"], "keyFrom": key_from,
            "contextWindow": resolved_window["contextWindow"],
            "contextWindowKnown": resolved_window["contextWindowKnown"],
            "contextWindowEstimated": resolved_window["contextWindowEstimated"],
            "contextWindowSource": resolved_window["contextWindowSource"],
            "modality": wanted, "config": config,
            "visionFallbackAvailable": adapter_configured() if wanted == "chat" else False,
            **(model_capabilities.runtime_fields(config, m.get("capabilityCheck"))
               if wanted == "chat" else {"imageRouting": ""}),
            "configRevision": m.get("configRevision", ""),
            "runtimeRevision": m.get("runtimeRevision", "")}


def agent_model(client, cli_key: str) -> str:
    """Return the client's model preference for an agent runtime, independent of machine or seat
    identity, or empty when unspecified.
    """
    table = dict(getattr(client, "agent_models", None) or {}) if client is not None else {}
    return canonical_model_name(table.get(str(cli_key or "").strip().lower(), ""))


async def resolve_for_agent(session: AsyncSession, client, cli_key: str,
                            override: str = "") -> dict:
    """Behavior and constraints for this operation."""
    want = canonical_model_name(str(override or "").strip() or agent_model(client, cli_key))
    if not want:
        return await resolve(session, client, "")
    # Check that a stored runtime preference remains usable.
    # Do not rely on implicit model substitution during resolution.
    # Keep preference validation and any fallback explicit to the caller.
    if any(m["name"] == want for m in await usable(session, client)):
        return await resolve(session, client, want)
    # If the stored preference becomes unavailable, explain any fallback to the default.
    got = await resolve(session, client, "")
    if got:
        got["fellBackFrom"] = want
    return got
