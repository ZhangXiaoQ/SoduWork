"""Fixed Harness² failure guidance; raw exception text is classification input only."""
from __future__ import annotations

import errno
import json
import re
import ssl
import urllib.error

_STAGES = {
    "prepare": "准备运行环境", "start": "启动执行组件",
    "initialize": "初始化执行组件", "session/new": "创建执行会话",
    "session/load": "恢复执行会话", "session/resume": "恢复执行会话",
    "session/set_mode": "应用会话权限", "session/set_config_option": "应用会话配置",
    "session/prompt": "调用模型", "refine": "推演执行方法",
    "planning": "推演执行方法", "cleanup": "清理执行组件", "close": "清理执行组件",
}
_HTTP_CODE = re.compile(
    r"\b(?:http(?:/\d(?:\.\d)?)?|status(?:[_ ]?code)?)\s*[\"':= ]*\s*(401|403|404|429)\b"
    r"|\b(401|403|429)\s+(?:unauthorized|forbidden|too many requests)\b",
    re.I,
)
_SAFE_CLASS = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,47}\Z")
_PHASES = {
    "base1": "生成初始执行计划", "inv1.a1": "提出通用方法改进",
    "dom1.a1": "提出任务方法改进", "inv1": "检查通用方法计划",
    "dom1": "检查任务方法计划", "c1.a1": "组合执行方法", "c1": "检查组合计划",
}
_DETAILS = {
    "model_config": "模型配置无效；请检查所选模型的服务地址、授权和输出上限。",
    "model_http": "模型服务拒绝或未完成请求；请检查模型授权、服务状态和请求配置。",
    "model_timeout": "模型连接或响应超时；请检查所选模型服务、网络和代理设置后重试。",
    "model_connection": "无法连接模型服务；请检查服务地址、网络、代理和证书设置。",
    "response_format": "模型响应格式无效；请检查该模型服务的接口兼容性。",
    "response_truncated": "模型输出被截断；请检查模型输出上限后重试。",
    "response_empty": "模型未返回完整有效的文本内容；请检查模型服务后重试。",
    "response_limit": "模型返回内容超过推演允许范围；请缩小本轮任务或调整模型输出。",
    "context_overflow": "模型上下文超限；完整历史已保留，将通过现有会话接续机制恢复。",
    "proposal_json": "模型返回的改进方案不是有效的纯 JSON；本轮未进入最终执行。",
    "proposal_schema": "改进方案的字段或数据类型不符合要求；本轮未进入最终执行。",
    "proposal_scope": "改进方案包含不允许的文件或路径；本轮未进入最终执行。",
    "proposal_limit": "改进方案超过允许的长度范围；本轮未进入最终执行。",
    "evidence_limit": "推演对比证据超过允许范围；请缩小本轮任务后重试。",
    "refinement_budget": "本次诊断推演已达到资源预算，未进入最终执行；已报告的模型用量仍计入本次消耗。",
    "cancelled": "推演进度已中断；本轮未进入最终执行。",
    "workspace_io": "推演工作文件读写失败；请检查运行目录的权限、空间和文件保护设置。",
    "input_invalid": "任务内容为空或超过允许长度；请调整任务后重试。",
    "workspace_not_empty": "本轮推演目录不是空目录；请重新发起本轮任务。",
    "engine_incomplete": "推演阶段未全部完成；本轮未进入最终执行，请重试。",
    "unknown": "推演发生未识别的错误；本轮未进入最终执行，请检查运行环境后重试。",
}


class Harness2Error(RuntimeError):
    """Compatibility base; its arbitrary message is not a structured diagnosis."""


class StructuredFailure(Harness2Error):
    """Only finite codes/phases and bounded HTTP status cross failure boundaries."""

    def __init__(self, code: str, *, phase: str = "", http_status: int | None = None):
        self.code = code if type(code) is str and code in _DETAILS else "unknown"
        self.phase = phase if type(phase) is str and phase in _PHASES else ""
        self.http_status = (http_status if self.code == "model_http"
                            and type(http_status) is int and 100 <= http_status <= 599 else None)
        super().__init__()

    def __str__(self) -> str:
        return _structured_message(self, "refine")


def _structured_message(exc: StructuredFailure, stage: str) -> str:
    # Revalidate rather than trusting exception args, overridden __str__, or
    # fields mutated after construction. Never include provider diagnostic text.
    safe = StructuredFailure(exc.code, phase=exc.phase, http_status=exc.http_status)
    label = _STAGES.get(stage, "执行") if type(stage) is str else "执行"
    if safe.phase:
        label += "（" + _PHASES[safe.phase] + "）"
    detail = _DETAILS[safe.code]
    if safe.code == "model_http" and safe.http_status is not None:
        detail = {
            401: "模型凭据无效或已过期；请检查模型授权。",
            403: "当前模型权限不足；请检查所选模型的访问授权。",
            404: "模型服务地址或模型不存在；请核对模型配置。",
            429: "模型服务限流或额度不足；请稍后重试或检查模型额度。",
        }.get(safe.http_status, detail)
        detail = f"模型请求失败（HTTP {safe.http_status}）：{detail}"
    return f"Google Harness² {label}失败：{detail}"


def _text(error: Exception, secret: str) -> str:
    try:
        text = str(error)
    except Exception:
        return ""
    if secret:
        text = text.replace(secret, "")
    return text[:32000].lower()


def failure_message(exc: Exception, stage: str, secret: str = "") -> str:
    """Return a fixed stage/category, safe code and suggestion, never raw diagnostics."""
    secret = secret if isinstance(secret, str) else ""
    if isinstance(exc, StructuredFailure):
        result = _structured_message(exc, stage)
        return result.replace(secret, "[redacted]") if secret else result
    name = type(exc).__name__
    safe_name = name if _SAFE_CLASS.fullmatch(name) and not (secret and secret in name) else "Exception"
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    text = _text(exc, secret) + " " + _text(reason, secret)
    code = exc.code if isinstance(exc, urllib.error.HTTPError) else None
    if code not in {401, 403, 404, 429}:
        matched = _HTTP_CODE.search(text)
        code = int(matched.group(1) or matched.group(2)) if matched else None
    label = _STAGES.get(stage, "执行") if isinstance(stage, str) else "执行"
    detail = ""

    if isinstance(exc, json.JSONDecodeError) or any(marker in text for marker in (
            "endoffileexpected", "configinvaliderror", "jsonparseerror",
            "json parse error", "invalid json", "unexpected end of json")):
        detail = "执行器配置无法解析；请检查 Harness² 模型配置或修复内置执行器。"
    elif any(marker in text for marker in (
            "providermodelnotfounderror", "model_not_found", "model not found",
            "model does not exist")):
        detail = "所选模型不存在或未配置；请核对模型名称和模型服务配置。"
    elif code == 401 or any(marker in text for marker in (
            "authentication required", "authentication_failed", "invalid api key",
            "incorrect api key", "unauthorized")):
        detail = "模型凭据无效或已过期" + ("（HTTP 401）" if code == 401 else "") + "；请检查模型授权。"
    elif code == 403:
        detail = "当前模型权限不足（HTTP 403）；请检查该模型的访问授权。"
    elif code == 429:
        detail = "模型服务限流或额度不足（HTTP 429）；请稍后重试或检查模型额度。"
    elif code == 404:
        detail = "模型服务地址或模型不存在（HTTP 404）；请核对服务地址和模型名称。"
    elif isinstance(reason, ssl.SSLError) or any(marker in text for marker in (
            "certificate_verify_failed", "certificate verify failed")):
        detail = "模型服务 TLS 校验失败；请检查服务证书和网络配置。"
    elif (isinstance(reason, PermissionError)
          or any(marker in text for marker in ("permissionerror", "eperm", "eacces"))):
        safe_code = ("EACCES" if "eacces" in text or getattr(reason, "errno", None) == errno.EACCES
                     else "EPERM" if "eperm" in text or getattr(reason, "errno", None) == errno.EPERM else "")
        detail = "本机文件访问被拒绝" + (f"（{safe_code}）" if safe_code else "") + "；请检查执行组件及其工作目录权限。"
    elif name == "AccessError" or "access_policy_unsupported" in text:
        detail = "会话权限确认失败；请检查执行组件版本和当前会话权限后重试。"
    elif isinstance(reason, TimeoutError) or any(marker in text for marker in ("etimedout", "timed out", "timeout")):
        detail = "连接或响应超时" + ("（ETIMEDOUT）" if "etimedout" in text else "") + "；请检查模型服务、网络和代理设置。"
    elif (isinstance(reason, ConnectionError) or isinstance(exc, urllib.error.URLError)
          or any(marker in text for marker in ("econnrefused", "econnreset", "enotfound", "fetch failed", "connection error"))):
        safe_code = next((value for value in ("ECONNREFUSED", "ECONNRESET", "ENOTFOUND")
                          if value.lower() in text), "")
        detail = "无法连接模型服务" + (f"（{safe_code}）" if safe_code else "") + "；请检查服务地址、网络和代理设置。"
    elif name == "ProcessCleanupError" or any(marker in text for marker in ("cleanup failed", "readers still active")):
        detail = "执行组件清理未完成；请确认本轮进程已结束后重试。"
    elif "acp agent exited early" in text:
        detail = "Harness² 独立执行器提前退出；请检查内置文件、配置及工作目录权限。"
    elif "acp agent failed to start" in text:
        detail = "Harness² 独立执行器无法启动；请检查内置文件和目录权限。"
    else:
        detail = f"出现未识别的错误（{safe_name}）；请检查模型配置或修复执行组件后重试。"

    result = f"Google Harness² {label}失败：{detail}"
    return result.replace(secret, "[redacted]") if secret else result
