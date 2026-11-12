"""Bounded native tool-calling transport for the selected managed model."""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from .harness2_errors import StructuredFailure
from .mcp_http import _NoRedirect, _response_chunks


def normalize_usage(value):
    from .runtime_messages import usage
    if not isinstance(value, dict):
        return {}
    result = dict(value)
    for names, source, target in (
            (("prompt_tokens_details", "input_tokens_details"), "cached_tokens", "cacheRead"),
            (("completion_tokens_details", "output_tokens_details"), "reasoning_tokens", "reasoning")):
        for name in names:
            detail = value.get(name)
            if isinstance(detail, dict) and source in detail:
                result.setdefault(target, detail[source])
                break
    return usage(result) or {}


def _anthropic_messages(messages):
    result = []
    for message in messages:
        if message["role"] == "system":
            continue
        role = "user" if message["role"] == "tool" else message["role"]
        if message["role"] == "tool":
            blocks = [{"type": "tool_result", "tool_use_id": message["tool_call_id"],
                       "content": message["content"]}]
        elif message.get("_anthropic"):
            blocks = message["_anthropic"]
        else:
            content = message.get("content") or ""
            blocks = []
            if isinstance(content, str):
                if content:
                    blocks.append({"type": "text", "text": content})
            else:
                for item in content:
                    if item["type"] == "text":
                        blocks.append(item)
                    elif item["type"] == "image_url":
                        prefix, data = item["image_url"]["url"].split(",", 1)
                        blocks.append({"type": "image", "source": {"type": "base64",
                            "media_type": prefix[5:].split(";")[0], "data": data}})
            for call in message.get("tool_calls") or []:
                blocks.append({"type": "tool_use", "id": call["id"],
                               "name": call["function"]["name"],
                               "input": json.loads(call["function"]["arguments"])})
        if result and result[-1]["role"] == role:
            result[-1]["content"].extend(blocks)
        else:
            result.append({"role": role, "content": list(blocks)})
    return result


def _off_options(model):
    """Return only supported off switches from the declared provider contract."""
    fmt = model.get("thinkingFormat")
    levels = model.get("thinkingLevelMap") or {}
    if not isinstance(levels, dict) or model.get("kind") == "anthropic":
        return {}
    if fmt in {"zai", "deepseek"}:
        return {"thinking": {"type": "disabled"}}
    if fmt == "qwen":
        return {"enable_thinking": False}
    if fmt == "qwen-chat-template":
        return {"chat_template_kwargs": {"enable_thinking": False, "preserve_thinking": True}}
    if fmt == "openrouter" and levels.get("off", "none") == "none":
        return {"reasoning": {"effort": "none"}}
    if (fmt == "openai" and model.get("supportsReasoningEffort") is True
            and levels.get("off") == "none"):
        return {"reasoning_effort": "none"}
    return {}


def can_disable_reasoning(model):
    """Count reasoning as disabled only when its off request can be sent."""
    levels = model.get("thinkingLevelMap")
    return (model.get("thinkingMode") == "controllable" and model.get("thinkingAlwaysOn") is not True
            and (not isinstance(levels, dict) or "off" not in levels or levels["off"] is not None)
            and bool(_off_options(model)))


def thinking_options(model, *, planning=False):
    """Match declared Pi-compatible thinking formats without model-name guesses."""
    if model.get("reasoning") is not True:
        return {}
    levels = model.get("thinkingLevelMap") or {}
    if not isinstance(levels, dict):
        return {}
    off_allowed = can_disable_reasoning(model)
    level = ("off" if off_allowed else "low") if planning else model.get("thinkingLevel")
    if not level:
        level = "off" if off_allowed else "low" if model.get("thinkingMode") == "always" else ""
    if level == "off" and not off_allowed:
        level = "low"
    fmt = model.get("thinkingFormat")
    result = {}
    if level == "off":
        return _off_options(model)
    effort = levels.get(level)
    if (model.get("supportsReasoningEffort") is True and fmt in {"openai", "zai", "deepseek", "qwen"}
            and isinstance(effort, str) and effort in {"minimal", "low", "medium", "high", "xhigh", "max"}):
        result["reasoning_effort"] = effort
    # Explicit user reasoning selection must enable the declared provider
    # switch; the planning-only low-effort compatibility request stays minimal.
    if not planning and level and level != "off":
        if fmt == "zai":
            result["thinking"] = {"type": "enabled", "clear_thinking": False}
        elif fmt == "deepseek":
            result["thinking"] = {"type": "enabled"}
        elif fmt == "qwen":
            result["enable_thinking"] = True
        elif fmt == "qwen-chat-template":
            result["chat_template_kwargs"] = {"enable_thinking": True, "preserve_thinking": True}
    return result


def request(model, messages, tools, *, timeout=90, on_text=None, on_usage=None, planning=False):
    """Return a validated assistant message and real usage; never retry actions."""
    import time

    base = str(model.get("base") or "").rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or not model.get("key") or not model.get("model")):
        raise StructuredFailure("model_config")
    limit = model.get("maxOutputTokens", 8192)
    if type(limit) is not int or not 1 <= limit <= 262144:
        raise StructuredFailure("model_config")
    anthropic = model.get("kind") == "anthropic"
    headers = {"Content-Type": "application/json"}
    if anthropic:
        url = base + ("/messages" if parsed.path.endswith("/v1") else "/v1/messages")
        headers.update({"x-api-key": str(model["key"]), "anthropic-version": "2023-06-01"})
        body = {"model": model["model"], "max_tokens": limit, "stream": True,
                "system": "\n\n".join(m["content"] for m in messages if m["role"] == "system"),
                "messages": _anthropic_messages(messages),
                "tools": [{"name": t["name"], "description": t["description"],
                           "input_schema": t["parameters"]} for t in tools]}
    else:
        url = base + "/chat/completions"
        headers["Authorization"] = "Bearer " + str(model["key"])
        output_key = ("max_completion_tokens" if model.get("reasoning") is True
                      and model.get("thinkingFormat") == "openai" else "max_tokens")
        body = {"model": model["model"], "stream": True, "stream_options": {"include_usage": True}, output_key: limit,
                "messages": [{k: v for k, v in m.items() if not k.startswith("_")}
                             for m in messages],
                "tools": [{"type": "function", "function": t} for t in tools]}
        body.update(thinking_options(model, planning=planning))
    if not tools:
        body.pop("tools", None)
    encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
    if len(encoded) > 32 * 1024 * 1024:
        raise StructuredFailure("response_limit")
    req = urllib.request.Request(url, encoded, headers, method="POST")
    def streamed_usage(value):
        tokens = normalize_usage(value)
        if on_usage and tokens:
            on_usage(tokens)
    try:
        deadline = time.monotonic() + timeout
        streamed = False
        with urllib.request.build_opener(_NoRedirect()).open(req, timeout=timeout) as response:
            if "text/event-stream" in response.headers.get("Content-Type", "").lower():
                from .harness2_streaming import read
                data = read(response, deadline, anthropic, on_text, streamed_usage)
                streamed = True
            else:
                data = json.loads(b"".join(_response_chunks(response, deadline)))
    except urllib.error.HTTPError as exc:
        status = exc.code
        try:
            detail = json.loads(exc.read(65537))
            error = detail.get("error") if isinstance(detail, dict) else None
            code = error.get("code") if isinstance(error, dict) else None
        except (ValueError, OSError):
            code = None
        finally:
            exc.close()
        if status in {400, 413} and isinstance(code, str) and code in {"context_length_exceeded", "context_window_exceeded"}:
            raise StructuredFailure("context_overflow") from None
        raise StructuredFailure("model_http", http_status=status) from None
    except TimeoutError:
        raise StructuredFailure("model_timeout") from None
    except urllib.error.URLError as exc:
        raise StructuredFailure("model_timeout" if isinstance(exc.reason, TimeoutError)
                                else "model_connection") from None
    except OSError:
        raise StructuredFailure("model_connection") from None
    except ValueError:
        raise StructuredFailure("response_format") from None
    tokens = normalize_usage(data.get("usage")) if isinstance(data, dict) else {}
    if on_usage and tokens and not streamed:
        on_usage(tokens)
    try:
        if anthropic:
            reason = data["stop_reason"]
            blocks = data["content"]
            content = "".join(b["text"] for b in blocks if b["type"] == "text")
            calls = [{"id": b["id"], "type": "function", "function": {
                "name": b["name"], "arguments": json.dumps(b["input"], ensure_ascii=False)}}
                for b in blocks if b["type"] == "tool_use"]
            message = {"role": "assistant", "content": content, "_anthropic": blocks}
            finished, calling = reason == "end_turn", reason == "tool_use"
        else:
            choice = data["choices"][0]
            reason = choice["finish_reason"]
            value = choice["message"]
            content = value.get("content") or ""
            calls = value.get("tool_calls") or []
            message = {"role": "assistant", "content": content}
            if isinstance(value.get("reasoning_content"), str):
                message["reasoning_content"] = value["reasoning_content"]
            finished, calling = reason == "stop", reason == "tool_calls"
        if reason in {"length", "max_tokens"}:
            raise StructuredFailure("response_truncated")
        if not isinstance(content, str) or not isinstance(calls, list) or len(calls) > 16:
            raise ValueError
        if not (finished and not calls and content.strip() or calling and calls):
            raise ValueError
        ids = set()
        for call in calls:
            if (not isinstance(call["id"], str) or not 1 <= len(call["id"]) <= 200
                    or call["id"] in ids or call.get("type") != "function"
                    or not isinstance(call["function"]["name"], str)
                    or not isinstance(call["function"]["arguments"], str)
                    or not isinstance(json.loads(call["function"]["arguments"]), dict)):
                raise ValueError
            ids.add(call["id"])
        if calls:
            message["tool_calls"] = calls
        if on_text and not streamed and content:
            on_text(content)
        return message, tokens
    except (KeyError, TypeError, ValueError, IndexError, AttributeError):
        raise StructuredFailure("response_format") from None
