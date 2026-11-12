"""Enterprise employee-catalog policy for approved plugins.

The policy is deliberately mutable and contains no credentials. Immutable
plugin versions describe what a capability is; bindings decide where governed
tasks run; this service decides how employees may add it to ordinary chats.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import automation_models as am, models
from . import plugin_covers


AVAILABLE = "available"
INSTALLED_BY_DEFAULT = "installed_by_default"
NOT_AVAILABLE = "not_available"
ON_INSTALL = "on_install"
ON_USE = "on_use"

INSTALLATION_VALUES = {AVAILABLE, INSTALLED_BY_DEFAULT, NOT_AVAILABLE}
AUTHENTICATION_VALUES = {ON_INSTALL, ON_USE}
CATEGORY_VALUES = {"automation", "connector", "method", "general"}
CATEGORY_SETTING_KEY = "plugin_catalog_categories"
CATEGORY_KEY = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")

DEFAULT_CATEGORIES = [
    {"key": "automation", "name": "自动化流程",
     "description": "多步骤工作流、定时执行与受控交付", "sort": 10, "enabled": True},
    {"key": "connector", "name": "业务连接",
     "description": "连接企业系统、数据源与 MCP 服务", "sort": 20, "enabled": True},
    {"key": "method", "name": "专业方法",
     "description": "把成熟岗位方法带进对话与需求", "sort": 30, "enabled": True},
    {"key": "general", "name": "通用能力",
     "description": "可直接使用的企业基础能力", "sort": 40, "enabled": True},
]

DEFAULT_POLICY = {
    "category": "general",
    "installation": AVAILABLE,
    "authentication": ON_USE,
    "featured": False,
    "coverUrl": "",
    "sort": 0,
}


def public_policy(row: am.PluginCatalogPolicy | dict | None) -> dict:
    configured = row is not None and (not isinstance(row, dict) or bool(row.get("configured", True)))
    if row is None:
        value = DEFAULT_POLICY
    elif isinstance(row, dict):
        value = {**DEFAULT_POLICY, **row}
    else:
        value = {
            "category": row.category,
            "installation": row.installation,
            "authentication": row.authentication,
            "featured": row.featured,
            "coverUrl": row.cover_url,
            "sort": row.sort,
        }
    return {
        "category": str(value.get("category") or "general"),
        "installation": str(value.get("installation") or AVAILABLE),
        "authentication": str(value.get("authentication") or ON_USE),
        "featured": bool(value.get("featured")),
        "coverUrl": plugin_covers.public(value.get("coverUrl")),
        "sort": int(value.get("sort") or 0),
        "configured": configured,
    }


def _category_rows(value=None) -> list[dict]:
    raw = value
    if isinstance(value, str):
        try:
            raw = json.loads(value or "[]")
        except json.JSONDecodeError:
            raw = []
    if not isinstance(raw, list) or not raw:
        raw = DEFAULT_CATEGORIES
    rows, seen = [], set()
    for index, item in enumerate(raw[:32]):
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip().lower()
        name = str(item.get("name") or "").strip()[:40]
        if not CATEGORY_KEY.fullmatch(key) or not name or key in seen:
            continue
        seen.add(key)
        try:
            sort = int(item.get("sort", (index + 1) * 10))
        except (TypeError, ValueError):
            sort = (index + 1) * 10
        rows.append({
            "key": key, "name": name,
            "description": str(item.get("description") or "").strip()[:160],
            "sort": max(-10000, min(10000, sort)),
            "enabled": bool(item.get("enabled", True)),
        })
    return sorted(rows or [dict(item) for item in DEFAULT_CATEGORIES],
                  key=lambda item: (item["sort"], item["name"]))


async def categories(session: AsyncSession, include_disabled: bool = False) -> list[dict]:
    row = await session.get(models.AppSetting, CATEGORY_SETTING_KEY)
    values = _category_rows(row.value if row is not None else None)
    return values if include_disabled else [item for item in values if item["enabled"]]


async def category_usage(session: AsyncSession) -> dict[str, int]:
    """Return how many plugin policies currently use each category.

    Usage is deliberately derived from policies instead of cached in the
    settings row so the admin editor always explains why a category cannot be
    deleted.  The query is bounded to the small catalog policy table.
    """
    rows = await session.execute(
        select(am.PluginCatalogPolicy.category, am.PluginCatalogPolicy.plugin_id)
    )
    counts: dict[str, int] = {}
    seen: set[tuple[str, str]] = set()
    for category, plugin_id in rows.all():
        key = (str(category or ""), str(plugin_id or ""))
        if not key[0] or key in seen:
            continue
        seen.add(key)
        counts[key[0]] = counts.get(key[0], 0) + 1
    return counts


async def replace_categories(session: AsyncSession, values, actor_id: str = "") -> list[dict]:
    if not isinstance(values, list):
        raise ValueError("分类清单必须是数组")
    if not 1 <= len(values) <= 32:
        raise ValueError("分类数量必须为 1 到 32 个")
    keys = set()
    for item in values:
        if not isinstance(item, dict):
            raise ValueError("分类必须是对象")
        key = str(item.get("key") or "").strip().lower()
        if key in keys or not CATEGORY_KEY.fullmatch(key):
            raise ValueError("分类键必须唯一，并使用 2-32 位小写字母、数字、短横线或下划线")
        keys.add(key)
        name = str(item.get("name") or "").strip()
        if not name or len(name) > 40:
            raise ValueError("分类名称必须为 1 到 40 个字符")
        sort = item.get("sort", 0)
        if isinstance(sort, bool) or not isinstance(sort, int) or abs(sort) > 10000:
            raise ValueError("排序必须是 -10000 到 10000 的整数")
        if not isinstance(item.get("enabled", True), bool):
            raise ValueError("启用状态必须是布尔值")
    rows = _category_rows(values)
    requested = {str(item.get("key") or "").strip().lower()
                 for item in values if isinstance(item, dict)}
    if len(rows) != len(requested) or not rows:
        raise ValueError("分类键必须唯一，并使用 2-32 位小写字母、数字、短横线或下划线")
    if not any(item["enabled"] for item in rows):
        raise ValueError("至少启用一个分类")
    used = set((await session.execute(select(am.PluginCatalogPolicy.category).distinct())).scalars())
    missing = sorted(value for value in used if value and value not in {x["key"] for x in rows})
    if missing:
        raise ValueError("已有插件正在使用这些分类，请改为停用而不是删除：" + "、".join(missing))
    row = await session.get(models.AppSetting, CATEGORY_SETTING_KEY)
    if row is None:
        row = models.AppSetting(key=CATEGORY_SETTING_KEY)
        session.add(row)
    row.value = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    await session.commit()
    return rows


def normalize(body: dict, current: am.PluginCatalogPolicy | dict | None = None,
              category_values=None) -> dict:
    if not isinstance(body, dict):
        raise ValueError("目录策略必须是对象")
    base = public_policy(current)
    category = str(body.get("category", base["category"]) or "").strip()
    installation = str(body.get("installation", base["installation"]) or "").strip()
    authentication = str(body.get("authentication", base["authentication"]) or "").strip()
    featured = body.get("featured", base["featured"])
    sort = body.get("sort", base["sort"])
    # An explicitly configured list is authoritative, including an empty set.
    # Falling back to the legacy four values when the caller passes an empty
    # set makes disabled/deleted categories appear valid again.
    allowed_categories = set(CATEGORY_VALUES if category_values is None else category_values)
    if category not in allowed_categories:
        raise ValueError("插件分类不支持：" + category)
    if installation not in INSTALLATION_VALUES:
        raise ValueError("员工安装策略不支持：" + installation)
    if authentication not in AUTHENTICATION_VALUES:
        raise ValueError("连接校验时机不支持：" + authentication)
    if not isinstance(featured, bool):
        raise ValueError("featured 必须是布尔值")
    if isinstance(sort, bool) or not isinstance(sort, int) or sort < -10000 or sort > 10000:
        raise ValueError("sort 必须是 -10000 到 10000 的整数")
    return {
        "category": category,
        "installation": installation,
        "authentication": authentication,
        "featured": featured,
        "coverUrl": plugin_covers.normalize(body.get("coverUrl", base["coverUrl"])),
        "sort": sort,
    }


async def by_plugin(session: AsyncSession, plugin_ids) -> dict[str, am.PluginCatalogPolicy]:
    ids = {str(value or "") for value in plugin_ids if str(value or "")}
    if not ids:
        return {}
    rows = list((await session.execute(select(am.PluginCatalogPolicy).where(
        am.PluginCatalogPolicy.plugin_id.in_(ids)
    ))).scalars().all())
    return {row.plugin_id: row for row in rows}


async def get(session: AsyncSession, plugin_id: str) -> am.PluginCatalogPolicy | None:
    return await session.get(am.PluginCatalogPolicy, str(plugin_id))


async def upsert(session: AsyncSession, plugin_id: str, body: dict,
                 actor_id: str = "", *, commit: bool = True) -> am.PluginCatalogPolicy:
    row = await get(session, plugin_id)
    configured = await categories(session, include_disabled=True)
    enabled = {item["key"] for item in configured if item["enabled"]}
    # Disabling a category must not invalidate existing policies. Keep the
    # current value selectable so an administrator can edit another field or
    # move the plugin to a new category before removing the old one.
    current_category = public_policy(row)["category"] if row is not None else ""
    allowed = enabled | ({current_category} if current_category else set())
    if not enabled:
        raise ValueError("至少启用一个分类")
    # An imported plugin has no policy row yet. The public default is "general",
    # which may be disabled or replaced by an administrator-managed category.
    # Pick the first enabled category so the first save can always assign it.
    if row is None and "category" not in body:
        first = next(item for item in configured if item["enabled"])
        body = {**body, "category": first["key"]}
    value = normalize(body, row, allowed)
    if row is None:
        row = am.PluginCatalogPolicy(plugin_id=str(plugin_id))
        session.add(row)
    for key, item in value.items():
        setattr(row, "cover_url" if key == "coverUrl" else key, item)
    row.updated_by = str(actor_id or "")[:64]
    if commit:
        await session.commit()
        await session.refresh(row)
    else:
        await session.flush()
    return row


# ---------------------------------------------------------------------------
# Administrator-managed application placement slots.

COMPOSE_SURFACE = "compose"
SIDEBAR_SURFACE = "sidebar"
RECOMMENDATION_SURFACES = {COMPOSE_SURFACE, SIDEBAR_SURFACE}
APP_KIND = "app"


def _recommendation_public(row: am.PluginRecommendation) -> dict:
    return {
        "id": row.id, "surface": row.surface, "kind": row.kind,
        "targetType": row.target_type, "targetId": row.target_id,
        "sort": row.sort, "payload": row.payload or {},
    }


async def by_target(session: AsyncSession, plugin_ids: list[str],
                    surface: str = COMPOSE_SURFACE) -> dict[str, am.PluginRecommendation]:
    """Placement rows for these plugins on one surface, keyed by target id."""
    ids = [str(item) for item in dict.fromkeys(plugin_ids) if item]
    if not ids:
        return {}
    rows = list((await session.execute(select(am.PluginRecommendation).where(
        am.PluginRecommendation.target_id.in_(ids),
        am.PluginRecommendation.target_type == "plugin",
        am.PluginRecommendation.surface == surface,
        am.PluginRecommendation.kind == APP_KIND,
    ))).scalars().all())
    return {row.target_id: row for row in rows}


async def sync_app_recommendation(session: AsyncSession, plugin_id: str, org_id: str | None,
                                  placed: bool, actor_id: str = "", *,
                                  commit: bool = True, surface: str = COMPOSE_SURFACE) -> am.PluginRecommendation | None:
    """Write one independent application placement, defaulting to compose.

    Runs in the caller's transaction (``commit=False``) so marketplace policy
    and the placement slot flip together; ``placed=False`` removes the row.
    """
    if surface not in RECOMMENDATION_SURFACES:
        raise ValueError("未知的推荐位置")
    row = (await by_target(session, [plugin_id], surface)).get(str(plugin_id))
    if not placed:
        if row is not None:
            await session.delete(row)
            if commit:
                await session.commit()
            else:
                await session.flush()
        return None
    if row is None:
        row = am.PluginRecommendation(org_id=org_id, surface=surface,
                                      kind=APP_KIND, target_type="plugin",
                                      target_id=str(plugin_id))
        session.add(row)
    row.enabled = True
    row.updated_by = str(actor_id or "")[:64]
    if commit:
        await session.commit()
        await session.refresh(row)
    else:
        await session.flush()
    return row


async def active_recommendations(session: AsyncSession, org_ids: set[str],
                                 surface: str, limit: int = 3) -> list[dict]:
    """Visible placement rows whose target plugin is still enabled.

    Deliberately thin: display material is derived by the client from the
    catalog it already fetched. Permission is re-checked hard when a chat
    actually starts the plugin, so listing only needs org visibility and a
    live liveness check on the target.
    """
    now = datetime.now(timezone.utc)
    visible = set(org_ids or set())
    condition = (am.PluginRecommendation.surface == surface,
                 am.PluginRecommendation.enabled.is_(True),
                 or_(am.PluginRecommendation.start_at.is_(None),
                     am.PluginRecommendation.start_at <= now),
                 or_(am.PluginRecommendation.end_at.is_(None),
                     am.PluginRecommendation.end_at >= now))
    if visible:
        condition = (*condition, (am.PluginRecommendation.org_id.is_(None) |
                                  am.PluginRecommendation.org_id.in_(visible)))
    else:
        condition = (*condition, am.PluginRecommendation.org_id.is_(None))
    rows = list((await session.execute(
        select(am.PluginRecommendation)
        .join(am.Plugin, am.Plugin.id == am.PluginRecommendation.target_id)
        .where(*condition, am.Plugin.enabled.is_(True))
        .order_by(am.PluginRecommendation.sort, am.PluginRecommendation.id)
    )).scalars().all())
    # One target must never fill two slots: a concurrent admin save can leave
    # two rows for the same plugin (application-level upsert, no partial
    # unique index across SQLite/PostgreSQL), so dedupe after ordering.
    seen: set[str] = set()
    out = []
    for row in rows:
        if row.target_id in seen:
            continue
        seen.add(row.target_id)
        out.append(_recommendation_public(row))
        if len(out) >= max(1, min(int(limit), 10)):
            break
    return out


async def app_recommended_on(session: AsyncSession, plugin_id: str,
                             surface: str = COMPOSE_SURFACE) -> bool:
    row = (await by_target(session, [plugin_id], surface)).get(str(plugin_id))
    return bool(row and row.enabled)
