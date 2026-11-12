"""Direct cloud entry using existing dispatch fences, tasks and execution sessions.

No native desktop session or workspace snapshot is needed. The durable Handoff
row is an internal start receipt, not another queue. Generic editable Task data
can never authorize remote routing or select input objects.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import unicodedata
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from ..agent_catalog import AGENTS
from ..config import get_settings
from ..conversation_handoff_models import ConversationHandoff as Handoff
from ..models import Attachment, Task
from . import conversation_handoffs as handoffs, storage
from . import cloud_code_delivery

MAX_FILES = 20
MAX_TOTAL_BYTES = 96 * 1024 * 1024


def clean_options(raw, has_files=False):
    if not isinstance(raw, dict) or set(raw) - {
        "sessionId", "agentId", "model", "title", "text", "userText", "inputPreparation", "requiredSkills", "targetRunnerId", "targetRunnerKind", "acceptance", "plugins"
    }:
        raise HTTPException(400, "云端会话选项不正确；不能指定本地目录、执行机或额外执行配置")
    out = {}
    for key, limit in (("sessionId", 160), ("agentId", 80), ("model", 200),
                       ("title", 200), ("text", 200000), ("userText", 200000)):
        value = raw.get(key, "")
        if not isinstance(value, str) or len(value) > limit or "\0" in value:
            raise HTTPException(400, "云端会话字段不正确：" + key)
        out[key] = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", out["sessionId"]):
        raise HTTPException(400, "云端会话编号格式不正确")
    if out["agentId"] not in AGENTS:
        raise HTTPException(422, "当前服务尚未配置此 Agent 的云端执行支持")
    input_preparation = raw.get("inputPreparation")
    if input_preparation is not None:
        if (not isinstance(input_preparation, dict)
                or set(input_preparation) - {"schemaVersion", "userText", "fallback"}):
            raise HTTPException(400, "云端输入理解选项不正确")
        user_text = input_preparation.get("userText", raw.get("userText", ""))
        if not isinstance(user_text, str) or len(user_text) > 50000 or "\0" in user_text:
            raise HTTPException(400, "云端输入理解的原始文字不正确")
        out["userText"] = user_text
        out["inputPreparation"] = {"schemaVersion": 1, "userText": user_text,
                                    "fallback": input_preparation.get("fallback") is True}
    else:
        out["userText"] = str(raw.get("userText", out["text"]))[:200000]
        out["inputPreparation"] = None
    if not out["text"] and not has_files:
        raise HTTPException(400, "请输入云端会话的第一条消息")
    required = raw.get("requiredSkills", [])
    if not isinstance(required, list) or len(required) > 100 or any(
            not isinstance(item, str) or not item or len(item) > 160 for item in required):
        raise HTTPException(400, "云端会话技能列表不正确")
    if any(item.lower() in {"computer-use", "computer_use", "desktop", "local-desktop"} for item in required):
        raise HTTPException(409, "本机电脑操作技能不能用于云端会话")
    out["requiredSkills"] = sorted(set(required))
    target_runner_id = raw.get("targetRunnerId", "")
    if not isinstance(target_runner_id, str) or len(target_runner_id) > 80 or (target_runner_id and not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", target_runner_id)):
        raise HTTPException(400, "移动端目标执行机标识不正确")
    out["targetRunnerId"] = target_runner_id.strip()
    target_runner_kind = raw.get("targetRunnerKind", "")
    if not isinstance(target_runner_kind, str) or target_runner_kind not in handoffs.RUNNER_KINDS | {""}:
        raise HTTPException(400, "目标执行机类型不正确")
    out["targetRunnerKind"] = target_runner_kind.strip()
    from . import conversation_turn_plugins
    plugins = conversation_turn_plugins.normalize(raw.get("plugins"))
    if plugins:
        if not out["targetRunnerId"] or out["targetRunnerKind"] != "work-computer" or raw.get("acceptance"):
            raise HTTPException(422, "本机插件需要明确选择本人电脑，不能用于验收会话")
        out["plugins"] = plugins
    if raw.get("acceptance") is not None:
        from . import cloud_acceptance
        out["acceptance"] = cloud_acceptance.clean(raw["acceptance"])
    return out


async def read_files(files):
    if len(files) > MAX_FILES:
        raise HTTPException(413, "云端会话最多可附加 20 个文件")
    result, names, total = [], set(), 0
    limit = min(MAX_TOTAL_BYTES, get_settings().attach_max_mb * 1024 * 1024)
    for upload in files:
        name = unicodedata.normalize("NFC", str(upload.filename or ""))
        if (not name or len(name) > 200 or name != name.strip() or name.endswith(".")
                or name in {".", ".."} or re.search(r'[\\/:*?"<>|\x00-\x1f\x7f]', name)
                or re.fullmatch(r"(?i)(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name)):
            raise HTTPException(400, "附件名称不正确，请只上传文件而不是目录路径")
        if name.casefold() in names:
            raise HTTPException(400, "附件包含重名文件，请重命名后再发送")
        names.add(name.casefold())
        content_type = str(upload.content_type or "application/octet-stream")
        if len(content_type) > 200 or re.search(r"[\x00-\x1f\x7f]", content_type):
            raise HTTPException(400, "附件类型不正确")
        data = await upload.read(min(limit, MAX_TOTAL_BYTES - total) + 1)
        total += len(data)
        if len(data) > limit or total > MAX_TOTAL_BYTES:
            raise HTTPException(413, "附件超过单文件或总大小上限")
        if not data:
            raise HTTPException(400, "不能上传空文件")
        result.append({"name": name, "contentType": content_type, "data": data,
                       "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    return result


async def _cleanup(objects):
    for key, backend in objects:
        await asyncio.to_thread(storage.delete, key, backend)


async def _resume(session, client, row, digest):
    if row.owner_user_id != client.user_ref:
        raise HTTPException(403, "设备归属已变更，不能访问原账号的云端会话")
    if row.phase == "aborted":
        return handoffs.public(row)
    if (row.source or {}).get("entryKind") != "cloud" or row.request_hash != digest:
        raise HTTPException(409, "此云端会话请求编号已用于另一条消息或附件，请使用原请求重试")
    return await handoffs.commit(session, client, row.transfer_id, row.sha256)


async def create(session, client, request_id, raw, uploads):
    user = await handoffs.owner(session, client)
    row_id = handoffs.identity(client.id, request_id)
    requested = clean_options(raw, has_files=bool(uploads))
    inputs = await read_files(uploads)
    descriptor = {"options": requested, "files": [
        {key: item[key] for key in ("name", "contentType", "size", "sha256")} for item in inputs]}
    digest = hashlib.sha256(json.dumps(descriptor, sort_keys=True, ensure_ascii=False,
                                      separators=(",", ":")).encode()).hexdigest()
    old = await session.get(Handoff, row_id)
    if old:
        return await _resume(session, client, old, digest)
    if requested.get("acceptance"):
        from . import cloud_acceptance
        await cloud_acceptance.validate(session, client, requested["acceptance"])
        if uploads:
            raise HTTPException(400, "自动验收只读取固定交付材料，请在验收前补充所需证据")
    source = {"entryKind": "cloud", "sessionId": requested["sessionId"],
              "adapterId": requested["agentId"], "modelName": requested["model"],
              "title": requested["title"] or requested["text"][:80], "goal": ""}
    code = cloud_code_delivery.context(requested["text"], str(uuid.uuid5(handoffs._NS, row_id + ":task")))
    if code:
        source.update(deliveryMode="git", codeDelivery=code["codeDelivery"])
    roster = await handoffs.targets(session, client)
    if requested["targetRunnerId"]:
        available = [item for item in roster
                     if item.get("runnerId") == requested["targetRunnerId"]
                     and item.get("agentId") == requested["agentId"]
                     and (not requested["targetRunnerKind"] or
                          item.get("runnerKind") == requested["targetRunnerKind"])]
    else:
        available = handoffs._automatic_targets(roster, requested["agentId"],
            source, requested["requiredSkills"])
        if requested["targetRunnerKind"]:
            available = [item for item in available
                         if item.get("runnerKind") == requested["targetRunnerKind"]]
    if not available:
        raise HTTPException(409, "暂时没有匹配 Agent、技能且可接单的云端环境，请在「我的 → 云端环境」检查连接、底座和负载")
    instruction = requested["text"] or "请根据本轮附件和用户说明理解任务后再处理。"
    options = {"assigneeId": available[0]["id"], "agentId": requested["agentId"],
               "model": requested["model"], "instruction": instruction,
               "userText": requested["userText"], "inputPreparation": requested["inputPreparation"],
               "requiredSkills": requested["requiredSkills"], "personalPlugins": [],
               **({"targetRunnerId": requested["targetRunnerId"]} if requested["targetRunnerId"] else {}),
               **({"targetRunnerKind": requested["targetRunnerKind"]}
                  if requested["targetRunnerKind"] else {})}
    picked = await handoffs.destination(session, client, options, source)
    if requested.get("plugins"):
        from . import conversation_turn_plugins
        await conversation_turn_plugins.validate_start(session, client, picked["runnerId"])
        options["plugins"] = requested["plugins"]
    # Keep the runner's reachable host alongside the friendly display name.
    # Cloud website previews may report localhost:<port>; the desktop must
    # rewrite that loopback to the selected Runner host before opening it.
    options["targetSnapshot"] = {key: str(picked.get(key) or "") for key in
                                 ("name", "runnerName", "agentId", "modelMode", "runnerId", "host", "runnerKind")}
    if requested.get("acceptance"):
        options["acceptance"] = requested["acceptance"]
    tid = str(uuid.uuid5(handoffs._NS, row_id + ":task"))
    objects, attachments, manifest = [], [], []
    committing = False
    try:
        for item in inputs:
            aid = str(uuid.uuid4())
            key = "cloud-inputs/" + row_id + "/" + aid + "/" + item["name"]
            backend = storage.backend_name()
            objects.append((key, backend))  # includes a possibly partial failed write
            backend = await asyncio.to_thread(storage.put, key, item["data"], item["contentType"])
            objects[-1] = (key, backend)
            attachments.append(Attachment(id=aid, task_id=tid, filename=item["name"],
                content_type=item["contentType"], size=item["size"], storage_key=key, backend=backend,
                uploaded_by=client.id, role="input", evidence_meta={"cloudRequestId": request_id}))
            manifest.append({"id": aid, **{k: item[k] for k in ("name", "contentType", "size", "sha256")}})
        options["inputs"] = manifest
        from . import conversation_content
        options = await conversation_content.save_options(picked["runnerId"], user.id, "handoff:" + row_id, options, session=session)
        row = Handoff(id=row_id, owner_client_id=client.id, owner_user_id=user.id,
            transfer_id=request_id, task_id=tid, sha256="", request_hash=digest,
            storage_key="", backend="", options=options, source=source,
            submitted_at=datetime.now(timezone.utc))
        task = Task(id=tid, owner_client_id=client.id, owner_user_id=user.id,
            title=source["title"], note="" if options.get("contentRef") else instruction,
            kind="task", status="todo", origin="cloud-conversation", created_by=user.id,
            created_by_name=user.display_name or user.username,
            work_routing={"selectedStrategy": "direct", "requiredSkills": requested["requiredSkills"],
                          "cloudConversation": {"requestId": request_id, "sessionId": requested["sessionId"]}})
        session.add_all([row, task, *attachments])
        committing = True
        await session.commit()
    except IntegrityError:
        await session.rollback()
        await _cleanup(objects)
        await session.refresh(client)
        old = await session.get(Handoff, row_id, populate_existing=True)
        if old is None:
            raise
        return await _resume(session, client, old, digest)
    except BaseException:
        await session.rollback()
        if committing:
            # A database disconnect may lose only the commit acknowledgement.
            # Never remove files already referenced by the durable start fence.
            # If even this lookup fails, retain the objects for a safe retry.
            persisted = await session.get(Handoff, row_id, populate_existing=True)
            protected = {item.get("id") for item in (persisted.options or {}).get("inputs", [])} if persisted else set()
            objects = [(key, backend) for key, backend in objects
                       if key.split("/")[-2] not in protected]
        await _cleanup(objects)
        raise
    return await handoffs.commit(session, client, request_id, "")


async def dispatch_inputs(session, row, extra):
    """Re-read only the first message's authorized, immutable input snapshot."""
    from . import conversation_content
    options = await conversation_content.load_options(row.owner_user_id, "handoff:" + row.id, row.options, session=session)
    selected = {str(item.get("name") or ""): item for item in extra.get("skills", [])}
    required = options.get("requiredSkills", [])
    if any(name not in selected for name in required):
        raise ValueError("云端会话所需技能已不可用，请恢复配置后重试")
    files = []
    for item in options.get("inputs", []):
        attachment = await session.get(Attachment, item["id"])
        if (not attachment or attachment.task_id != row.task_id
                or attachment.uploaded_by != row.owner_client_id or attachment.role != "input"):
            raise ValueError("云端会话附件已不存在或不属于本次消息，请重新发送")
        data = await asyncio.to_thread(storage.get, attachment.storage_key, attachment.backend)
        if len(data) != item["size"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("云端会话附件已变化，请重新发送")
        files.append((item["name"], data, item["contentType"]))
    user_text = options.get("userText", options["instruction"])
    prep = options.get("inputPreparation")
    brief = options["instruction"]
    if options.get("acceptance"):
        from . import cloud_acceptance
        files, brief = await cloud_acceptance.inputs(session, row, instruction=options["instruction"])
    if prep:
        brief = brief + "\n\n【附件理解约束】先区分步骤、处理对象、模板和参考；用户原始文字为空时，不得把这段兜底说明当成用户目标。"
    plugin_context = {}
    if options.get("plugins"):
        from ..models import Client
        from . import conversation_turn_plugins, dispatch_identity
        caller = await session.get(Client, row.owner_client_id)
        if not caller or caller.user_ref != row.owner_user_id:
            raise ValueError("会话归属已变化，不能使用原电脑插件")
        runner = await conversation_turn_plugins.validate_start(
            session, caller, options["targetSnapshot"]["runnerId"])
        dispatch_id = handoffs.dispatch_id(row)
        plugin_context["pluginTurn"] = conversation_turn_plugins.authorization(
            caller, runner, dispatch_identity.execution_ref(dispatch_id), options["plugins"], dispatch_id)
    return files, {**plugin_context, "dispatchId": handoffs.dispatch_id(row), "brief": brief,
        "conversationMode": "adaptive", "conversationUserText": user_text,
        "inputPreparation": prep,
        "agentExecution": extra.get("agentExecution", {}),
        "skills": [selected[name] for name in required], "requiredSkills": required,
        "requiredAgentCapabilities": ["files", "terminal"],
        **cloud_code_delivery.context(options["instruction"], row.task_id)}
