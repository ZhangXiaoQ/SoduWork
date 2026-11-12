"""Runner follow-up admission, attachments and explicit executor selection."""
import asyncio
import os
import uuid

from . import ai_local, runner_admission


def _duplicate(machine, ref, turn_id, message):
    previous = machine._admission.get("comment:" + turn_id)
    if previous is None:
        return None
    expected = previous.request_digest or (runner_admission.comment_digest(previous.ref, previous.payload)
                                           if previous.payload is not None else "")
    if previous.ref != ref or (expected and expected != runner_admission.comment_digest(ref, message)):
        return {"ok": False, "code": "MESSAGE_ID_CONFLICT", "error": "消息编号已用于其他内容或执行选择"}
    return {"ok": True, "data": machine._admission.receipt(previous, duplicate=True)}


async def comment(machine, m, read_local_files, read_packet=None, drop_transfer=None):
    from app.services import local_stream
    ref = str(m.get("ref") or "")
    if not ref:
        return {"ok": False, "error": "会话标识不能为空"}
    from app.services import dispatch_identity
    turn_id = dispatch_identity.clean_dispatch_id(m.get("turnId"))
    if not turn_id:
        turn_id = "turn:" + uuid.uuid4().hex
        m = dict(m)
        m["turnId"] = turn_id
    selected = None
    if m.get("executionSelection") is not None:
        from . import execution_selection
        try:
            m = {**m, "executionSelection": execution_selection.normalize(m["executionSelection"])}
        except execution_selection.SelectionError as exc:
            return {"ok": False, "code": getattr(exc, "code", "EXECUTION_SELECTION_INVALID"), "error": str(exc)}
    if not m.get("_admitted"):
        previous = _duplicate(machine, ref, turn_id, m)
        if previous is not None:
            return previous
    if m.get("executionSelection") is not None:
        from . import execution_selection, runner_turn_selection
        try:
            raw = execution_selection.normalize(m["executionSelection"])
            selected = await asyncio.to_thread(runner_turn_selection.validate, ref, raw, m.get("cfg"))
            from . import local_base
            with local_base._LOCK:
                switching = selected != execution_selection.current(local_base._RUNS.get(ref) or {})
            machine._reap_admission()
            if switching and not m.get("_admitted") and machine._admission.latest_for_ref(ref):
                raise execution_selection.SelectionError("请等待当前轮次及排队消息完成后再切换", "EXECUTION_SWITCH_BUSY")
            m = {**m, "executionSelection": raw, "_acceptedSelection": selected}
        except (execution_selection.SelectionError, ValueError) as exc:
            return {"ok": False, "code": getattr(exc, "code", "EXECUTION_SELECTION_INVALID"), "error": str(exc)}
    if not m.get("_admitted"):
        # Selection validation awaits native state. Another request may have
        # admitted this business ID during that await, including different text.
        previous = _duplicate(machine, ref, turn_id, m)
        if previous is not None:
            return previous
        result = await machine._admit(m, key="comment:" + turn_id, ref=ref,
            category=runner_admission.INTERACTIVE, operation="comment")
        if selected and result.get("ok"):
            item = machine._admission.get("comment:" + turn_id)
            result["data"] = {**result.get("data", {}), "acceptedSelection": selected,
                              "acceptedSelectionRevision": item.sequence}
        return result
    user_text = str(m.get("text") or "")
    text = str(m.get("promptText") or user_text)
    prepared_plugins = None
    if m.get("pluginTurn"):
        from . import runner_turn_plugins
        try:
            prepared_plugins = await runner_turn_plugins.prepare(machine, m)
            text = prepared_plugins["promptText"]
            m = {**m, "plugins": prepared_plugins["plugins"]}
        except (ValueError, KeyError, TimeoutError) as exc:
            return {"ok": False, "error": str(exc)}
    prepared_skills = None
    if m.get("turnSkills"):
        from . import conversation_turn_skills
        try:
            prepared_skills = await conversation_turn_skills.prepare(machine, m)
            text += prepared_skills["prompt"]
        except (ValueError, KeyError, OSError) as exc:
            return {"ok": False, "error": str(exc)}
    staged = []
    packet = m.get("files") or {}
    if packet.get("items"):
        if read_packet is None:
            return {"ok": False, "error": "执行机不支持本轮材料"}
        try:
            files = await asyncio.to_thread(read_packet, packet, "本轮补充文件")
            inputs = [(meta["filename"], data, meta.get("contentType") or "application/octet-stream") for meta, data in files]
            staged = await asyncio.to_thread(ai_local._stage_inputs, ref, inputs)
            if len(staged) != len(inputs):
                return {"ok": False, "error": "本轮文件未完整保存，没有继续执行"}
            text += "\n\n【本轮补充文件】\n" + "\n".join("- %s：%s" % (item["name"], item["path"]) for item in staged)
        except (ValueError, OSError) as exc:
            return {"ok": False, "error": str(exc)}
        finally:
            if drop_transfer:
                await drop_transfer(str(packet.get("transfer") or ""))
    if m.get("_localParent") and m.get("localFiles"):
        files = read_local_files(m.get("localFiles") or [], "\u8865\u5145\u9644\u4ef6")
        inputs = [(str(meta.get("filename") or "\u9644\u4ef6"), data,
                   str(meta.get("contentType") or "application/octet-stream"))
                  for meta, data in files]
        staged = await asyncio.to_thread(ai_local._stage_inputs, ref, inputs)
        if staged:
            text += "\n\n\u3010\u672c\u8f6e\u8865\u5145\u6587\u4ef6\u3011\n" + "\n".join(
                "- %s\uff1a%s" % (item.get("name") or "\u9644\u4ef6", item.get("path") or "")
                for item in staged)
    if m.get("recordUser"):
        await asyncio.to_thread(local_stream.record_user_sync, ref, user_text, staged,
                                m.get("plugins"), m.get("sentAt"))
    from app.services import runtime_images
    try:
        cfg = {**dict(m.get("cfg") or {}), "_admissionKey": str(m.get("_admissionKey") or "")}
        if prepared_skills is not None:
            cfg["skillSelection"] = prepared_skills["selection"]
        if prepared_plugins is not None:
            cfg["pluginResourceBundles"] = prepared_plugins["resourceBundles"]
        elif not m.get("_localParent"):
            cfg["pluginResourceBundles"] = []
        if selected is not None:
            cfg["_executionSelection"] = selected
        turn_cfg = await asyncio.to_thread(runtime_images.prepare, cfg,
            staged, os.path.join(ai_local._store_dir(ref), "inputs"))
    except (runtime_images.ImageInputError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    result = await asyncio.to_thread(
        local_stream.comment_sync, turn_cfg, ref, text)
    return {"ok": bool(result.get("ok")), "data": result,
            "error": str(result.get("error") or "")}
