"""Bounded provider stream assembly; partial text is never a completion proof."""
from __future__ import annotations

import codecs
import json

from .harness2_errors import StructuredFailure
from .mcp_http import _response_chunks


def read(response, deadline, anthropic, on_text, on_usage=None):
    decoder = codecs.getincrementaldecoder("utf-8")()
    pending, data_lines = "", []
    text, reasoning, calls, blocks, usage = [], [], {}, {}, {}
    reason, ended = None, False

    def event(raw):
        nonlocal reason, ended, usage
        if raw == "[DONE]":
            if anthropic or ended:
                raise StructuredFailure("response_format")
            ended = True
            return
        value = json.loads(raw)
        if not isinstance(value, dict) or value.get("error") or value.get("type") == "error":
            raise StructuredFailure("response_format")
        if ended:
            raise StructuredFailure("response_format")
        if anthropic:
            kind = value.get("type")
            if kind == "message_start":
                usage.update(value.get("message", {}).get("usage") or {})
            elif kind in {"content_block_start", "content_block_delta"}:
                index = value["index"]
                if type(index) is not int or not 0 <= index < 64:
                    raise StructuredFailure("response_limit")
                if kind == "content_block_start":
                    if index in blocks:
                        raise StructuredFailure("response_format")
                    block = dict(value["content_block"])
                    blocks[index] = block
                    if block.get("type") == "tool_use":
                        block["_json"] = ""
                    if block.get("type") == "text" and block.get("text") and on_text:
                        on_text(block["text"])
                else:
                    block, delta = blocks[index], value["delta"]
                    field = {"text_delta": "text", "thinking_delta": "thinking",
                             "signature_delta": "signature", "input_json_delta": "_json"}.get(delta["type"])
                    if not field:
                        raise StructuredFailure("response_format")
                    chunk = delta["partial_json" if field == "_json" else field]
                    if not isinstance(chunk, str):
                        raise StructuredFailure("response_format")
                    block[field] = block.get(field, "") + chunk
                    if field == "text" and on_text:
                        on_text(chunk)
            elif kind == "message_delta":
                reason = value.get("delta", {}).get("stop_reason") or reason
                usage.update(value.get("usage") or {})
            elif kind == "message_stop":
                ended = True
        else:
            if value.get("usage"):
                usage = value["usage"]
            choices = value.get("choices") or []
            if choices:
                choice = choices[0]
                if choice.get("index", 0) != 0:
                    raise StructuredFailure("response_format")
                reason = choice.get("finish_reason") or reason
                delta = choice.get("delta") or {}
                chunk = delta.get("content")
                if chunk:
                    if not isinstance(chunk, str):
                        raise StructuredFailure("response_format")
                    text.append(chunk)
                    if on_text:
                        on_text(chunk)
                if isinstance(delta.get("reasoning_content"), str):
                    reasoning.append(delta["reasoning_content"])
                for part in delta.get("tool_calls") or []:
                    index = part["index"]
                    if type(index) is not int or not 0 <= index < 16:
                        raise StructuredFailure("response_limit")
                    call = calls.setdefault(index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                    if part.get("id"):
                        if call["id"] and call["id"] != part["id"]:
                            raise StructuredFailure("response_format")
                        call["id"] = part["id"]
                    for field in ("name", "arguments"):
                        chunk = (part.get("function") or {}).get(field)
                        if chunk:
                            if not isinstance(chunk, str):
                                raise StructuredFailure("response_format")
                            call["function"][field] += chunk

    try:
        for chunk in _response_chunks(response, deadline):
            pending += decoder.decode(chunk)
            while "\n" in pending:
                line, pending = pending.split("\n", 1)
                line = line.rstrip("\r")
                if not line and data_lines:
                    event("\n".join(data_lines))
                    data_lines.clear()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].lstrip(" "))
            # A validated terminal event ends inference even when an HTTP peer
            # leaves its transport alive. Waiting for EOF can turn completed
            # answers into timeouts. Usage precedes the provider terminal event.
            if ended:
                # SSE comments are transport keepalives, not model output. A
                # coalesced comment may stop mid-line or mid-codepoint after
                # completion; do not wait for its remaining bytes. Real data
                # already received after the terminal event is still rejected.
                if pending.startswith(":") and not data_lines:
                    pending = ""
                    decoder.reset()
                break
        pending += decoder.decode(b"", final=True)
        if pending.strip() or data_lines or not ended or not reason:
            raise StructuredFailure("response_truncated")
        if anthropic:
            content = []
            for index in sorted(blocks):
                block = blocks[index]
                if "_json" in block:
                    raw = block.pop("_json")
                    if raw:
                        block["input"] = json.loads(raw)
                content.append(block)
            return {"content": content, "stop_reason": reason, "usage": usage}
        message = {"role": "assistant", "content": "".join(text),
                   "tool_calls": [calls[index] for index in sorted(calls)]}
        if reasoning:
            message["reasoning_content"] = "".join(reasoning)
        return {"choices": [{"message": message, "finish_reason": reason}], "usage": usage}
    except (TypeError, ValueError, KeyError, IndexError, AttributeError):
        raise StructuredFailure("response_format") from None
    finally:
        if on_usage and usage:
            on_usage(usage)
