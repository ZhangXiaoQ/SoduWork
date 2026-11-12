"""Batch quota reads from the authoritative, frozen usage ledger."""
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, union_all

from ..models import AIUsageDaily, AIUsageEvent
from .model_catalog import canonical_model_name

CHINA_TZ = timezone(timedelta(hours=8))


def month_window(now=None):
    local = (now or datetime.now(timezone.utc)).astimezone(CHINA_TZ)
    start = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    return start, end


async def totals(session, user_ids, *, monthly=True, now=None):
    """One grouped query per page, independent of member or model count.

    Legacy cumulative events contribute only when no daily facts exist. Lifetime
    trial usage includes every increment for the account; changing plans, devices
    or calendar months cannot refill a trial.
    """
    ids = list(dict.fromkeys(str(uid) for uid in user_ids if uid))
    result = defaultdict(dict)
    if not ids:
        return result
    daily = select(AIUsageDaily.billing_user_id.label("uid"),
                   AIUsageDaily.provider.label("provider"), AIUsageDaily.model.label("model"),
                   func.sum(AIUsageDaily.total_tokens).label("tokens")).where(
                        AIUsageDaily.billing_user_id.in_(ids), AIUsageDaily.quota_scope != "personal")
    legacy = select(AIUsageEvent.billing_user_id.label("uid"),
                    AIUsageEvent.provider.label("provider"), AIUsageEvent.model.label("model"),
                    func.sum(AIUsageEvent.total_tokens).label("tokens")).where(
                        AIUsageEvent.billing_user_id.in_(ids),
                        ~select(AIUsageDaily.id).where(
                            AIUsageDaily.usage_event_id == AIUsageEvent.id).exists())
    if monthly:
        start, end = month_window(now)
        daily = daily.where(AIUsageDaily.day_key >= start.date().isoformat(),
                            AIUsageDaily.day_key < end.date().isoformat())
        legacy = legacy.where(AIUsageEvent.occurred_at >= start.astimezone(timezone.utc),
                              AIUsageEvent.occurred_at < end.astimezone(timezone.utc))
    daily = daily.group_by(AIUsageDaily.billing_user_id, AIUsageDaily.provider, AIUsageDaily.model)
    legacy = legacy.group_by(AIUsageEvent.billing_user_id, AIUsageEvent.provider, AIUsageEvent.model)
    for uid, provider, model, count in (await session.execute(union_all(daily, legacy))):
        key = (str(provider or ""), canonical_model_name(model))
        result[uid][key] = result[uid].get(key, 0) + max(0, int(count or 0))
    return result
