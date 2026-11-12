"""Shared model gateway errors for synchronous probes and async transports."""

import json
import re


def billing_diagnostic(value) -> dict | None:
    """Keep only recognized billing codes, never provider text or arbitrary fields."""
    payload = value if isinstance(value, dict) else None
    if payload is None:
        try:
            raw = str(value or "")[:16000]
            payload = json.loads(raw[raw.index("{"):])
        except (ValueError, TypeError):
            return None
    if not isinstance(payload, dict):
        return None
    error = payload.get("error", payload)
    if not isinstance(error, dict):
        return None
    code = str(error.get("code") or "")
    category = str(error.get("type") or "")
    if code == "1113":
        return {"code": "upstream_billing_error", "providerCode": "1113"}
    known = {"insufficient_quota", "insufficient_balance", "billing_hard_limit_reached",
             "billing_not_active", "upstream_billing_error"}
    if code in known or category in known:
        return {"code": "upstream_billing_error"}
    return None


def billing_message(diagnostic: dict) -> str:
    code = "；供应商错误码 1113" if diagnostic.get("providerCode") == "1113" else ""
    # The established SDK recognizes billing failures even when it retains only message.
    return ("模型服务余额不足或计费额度不可用（billing_required" + code +
            "），请检查供应商账单、API Key 类型和接口地址；重试不会恢复额度")


def public_failure(value) -> str:
    """Classify provider diagnostics without exposing response bodies or credentials."""
    raw = str(value or "")[:16000]
    payload = value if isinstance(value, dict) else None
    if payload is None:
        try:
            payload = json.loads(raw[raw.index("{"):])
        except (ValueError, TypeError):
            pass
    status = 0
    if isinstance(payload, dict):
        nested = payload.get("error")
        for item in (nested, payload):
            if not isinstance(item, dict):
                continue
            for key in ("status", "statusCode", "code"):
                candidate = str(item.get(key) or "")
                if re.fullmatch(r"[45]\d{2}", candidate):
                    status = int(candidate)
                    break
            if status:
                break
    if not status:
        match = re.search(
            r"\bHTTP(?:/\d(?:\.\d)?)?\s+([45]\d{2})\b"
            r"|^([45]\d{2})(?=$|[\s:<({])"
            r"|\bstatus(?:[_ ]?code)?\s*[:=]?\s*([45]\d{2})\b", raw, re.I)
        if match:
            status = int(next(group for group in match.groups() if group))
    diagnostic = billing_diagnostic(payload)
    if diagnostic:
        return billing_message(diagnostic)
    suffix = f"（HTTP {status}）" if status else ""
    if status == 404:
        return "模型服务地址或模型不存在" + suffix + "；请切换可用模型，或联系管理员核对服务地址与模型名称。"
    if status in {401, 403}:
        return "模型服务拒绝了当前凭据或模型权限" + suffix + "；请检查模型授权或切换有权限的模型。"
    if status == 429:
        return "模型服务当前繁忙或额度受限" + suffix + "；请稍后重试或检查模型额度。"
    if status in {408, 425} or status >= 500 or re.search(
            r"timeout|timed\s*out|ECONNRESET|ECONNREFUSED|fetch failed|connection error", raw, re.I):
        return "模型服务暂时不可用" + suffix + "；请稍后重试，已有进度已保留。"
    if status:
        return "模型服务未能处理当前请求" + suffix + "；请检查模型配置和输入内容。"
    return "模型调用失败，已有进度已保留；请重试或切换可用模型。"


class UpstreamError(Exception):
    """Preserve the gateway status and response without converting it to HTTP 500."""

    def __init__(self, status: int, body: str, detail: str = ""):
        super().__init__(detail or f"HTTP {status}")
        self.status = status
        self.body = body
        self.detail = detail or f"HTTP {status}"
