"""Server-derived model funding and signed attribution for new usage increments.

Receipts attest credential selection, not the accuracy of client token counters.
Missing, old or invalid receipts remain charged to the platform budget.
"""
import hashlib
import hmac
import json
from ..auth import sign_claims, verify_claims
from ..config import get_settings

VERSION = 2
RECEIPT_TTL = 30 * 24 * 60 * 60  # Allow the existing durable outbox to settle offline work.


def scope(provider, key_from):
    return "personal" if key_from == "mine" or (
        key_from == "none" and provider.get("personal") is True) else "platform"


def binding(conf):
    """Bind a proxy ticket to actual credentials without disclosing a key hash."""
    data = {key: conf.get(key) for key in
            ("provider", "model", "base", "key", "kind", "quotaScope", "runtimeRevision", "configRevision")}
    return hmac.new(get_settings().auth_secret.encode(),
        b"model-quota-binding:" + json.dumps(data, sort_keys=True, separators=(",", ":")).encode(),
        hashlib.sha256).hexdigest()


def usage_token(client, conf):
    from .model_config_guard import revision
    return sign_claims({
        "uid": str(client.user_ref or ""), "cid": str(client.id),
        "ver": int(client.auth_version or 1),
        "provider": str(conf.get("provider") or ""), "model": str(conf.get("model") or ""),
        "revision": str(revision(client)) + ":" + binding(conf),
        "scope": conf.get("quotaScope", "platform"), "runtime": "pi",
    }, token_type="model-quota-usage", ttl_seconds=RECEIPT_TTL)


def reported_scope(client, payload):
    token = payload.get("quotaUsageToken")
    if not isinstance(token, str) or len(token) > 8192:
        return "platform"
    claims = verify_claims(token, token_type="model-quota-usage")
    runtime = str(payload.get("agent") or payload.get("agentKey") or "").strip().lower().removeprefix("local:")
    if not claims or claims.get("scope") != "personal" or claims.get("runtime") != "pi" or runtime != "pi":
        return "platform"
    expected = {"uid": str(client.user_ref or ""), "cid": str(client.id),
                "ver": int(client.auth_version or 1),
                "provider": str(payload.get("provider") or ""),
                "model": str(payload.get("model") or "")}
    return "personal" if all(claims.get(key) == value for key, value in expected.items()) else "platform"


def describe(status):
    """Advertise only an unambiguous budget recovery path to older UI surfaces."""
    paused = status.get("enabled") and status.get("limit") == 0 and (
        status.get("totalLimited", True))
    eligible = bool(status.get("exceeded") and not paused and not status.get("restrictModels")
                    and status.get("reason") != "trial_expired")
    return {**status, "quotaVersion": VERSION, "personalModelsAllowed": eligible}


def admission(status, *, personal=False):
    """Budget exemption does not waive entitlement, an AI pause, or an allowlist."""
    if not personal:
        return status
    selected = status.get("model")
    denied_model = bool(status.get("restrictModels") and status.get("requestedModel") and selected is None)
    paused = (status.get("enabled") and status.get("limit") == 0 and status.get("totalLimited", True)) or (
        selected is not None and selected.get("limit") == 0)
    if denied_model:
        return {**status, "exceeded": True, "reason": "model_not_allowed", "personalModelsAllowed": False}
    if paused or status.get("reason") == "trial_expired":
        return {**status, "exceeded": True, "personalModelsAllowed": False}
    return {**status, "exceeded": False, "reason": "", "quotaScope": "personal"}


async def revalidate_selection(session, conf):
    """A capacity wait cannot keep using revoked/reassigned personal credentials."""
    if conf.get("quotaScope") != "personal" and not conf.get("quotaBinding"):
        return
    from ..models import Client, User
    from . import model_catalog, device_auth
    from .model_errors import UpstreamError
    from .legal_publications import assert_ai_access
    client = await session.get(Client, conf.get("quotaClientId", ""), populate_existing=True)
    user = await session.get(User, conf.get("quotaUserId", ""), populate_existing=True)
    try:
        device_auth._assert_active_binding_loaded(client, user, {
            "cid": conf.get("quotaClientId"), "uid": conf.get("quotaUserId"),
            "ver": conf.get("quotaAuthVersion")})
    except device_auth.DeviceAuthError as exc:
        raise UpstreamError(exc.status, "", str(exc)) from exc
    await assert_ai_access(session, str(client.user_ref or ""))
    fresh = await model_catalog.resolve(session, client, conf.get("model", ""),
        conf.get("modality", "chat"), provider_id=conf.get("provider", ""))
    fresh["quotaScope"] = fresh.get("fundingScope", "platform")
    if not fresh or binding(fresh) != binding(conf):
        raise UpstreamError(409, "", "模型凭据已变化，请重新选择模型后继续")
