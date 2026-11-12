"""Shared schedule request and response contract for both authorization views.

Authorization and owner selection remain in each router. Timestamp formatting is
provided by the caller to preserve the existing tolerant personal view.
"""
from fastapi import HTTPException


def schedule_payload(s, *, timestamp, administrative=False) -> dict:
    from datetime import datetime, timezone
    from ..services import schedules as sch
    # Automation is a plain conversation. Enterprise workflow bindings are not
    # exposed, while a personal plugin remains an ordinary-chat plugin resolved
    # by the owner desktop.
    # A finite custom rule can still have a pending first occurrence after its
    # wall time. Use the same durable origin as due(), not the response clock.
    origin = s.last_run_at or (s.created_at if s.every == "custom" else None)
    next_at = sch.next_run_instant(s, origin)
    end_date = str(getattr(s, "end_date", None) or "")
    current = datetime.now(timezone.utc)
    if s.every not in ("once", "custom") and end_date and current.astimezone(sch.schedule_zone(s)).date().isoformat() > end_date:
        pending = sch.next_run_instant(s, s.last_run_at or s.created_at)
        next_at = pending if sch.calendar_window_allows(s, current, pending) else None
    next_local = next_at.astimezone(sch.schedule_zone(s)) if next_at else None
    personal_key = str(getattr(s, "personal_plugin_key", "") or "")
    personal_policy = str(getattr(s, "personal_plugin_version_policy", "latest") or "latest")
    personal_version = str(getattr(s, "personal_plugin_version", "") or "")
    personal_checksum = str(getattr(s, "personal_plugin_checksum", "") or "")
    # Old rows may retain version metadata after their personal plugin was
    # cleared. Do not advertise a phantom pinned plugin to a new editor.
    if not personal_key:
        personal_policy, personal_version, personal_checksum = "latest", "", ""
    weekdays = sch.schedule_timing.clean_weekdays(getattr(s, "weekdays", None))
    if s.every == "weekly" and not weekdays:
        weekdays = sch.schedule_timing.clean_weekdays(getattr(s, "weekday", None))
    payload = {"id": s.id, "title": s.title, "note": s.note, "every": s.every,
            "runAt": timestamp(getattr(s, "run_at", None)),
            "onceFired": bool(getattr(s, "once_fired", False)),
            "atHour": s.at_hour, "atMinute": s.at_minute, "weekday": s.weekday,
            "customRule": str(getattr(s, "custom_rule", "") or ""),
            "weekdays": weekdays,
            "monthDays": sch.schedule_timing.clean_month_days(getattr(s, "month_days", None)),
            "monthDayPolicy": str(getattr(s, "month_day_policy", "skip") or "skip"),
            "startDate": str(getattr(s, "start_date", None) or ""),
            "endDate": str(getattr(s, "end_date", None) or ""),
            "timeZone": sch.clean_time_zone(s.time_zone),
            "assigneeId": s.assignee_id, "assigneeType": s.assignee_type,
            "modelName": str(getattr(s, "model_name", "") or ""),
            "repoId": s.repo_id, "flow": False, "enabled": bool(s.enabled),
            "pluginBindingId": "",
            "personalPluginKey": personal_key,
            "personalPluginVersionPolicy": personal_policy,
            "personalPluginVersion": personal_version,
            "personalPluginChecksum": personal_checksum,
            "pluginInputs": sch.clean_plugin_inputs(
                getattr(s, "plugin_inputs", {}) or {}),
            "executionMode": ("personal" if personal_key else "direct"),
            "requiredCapabilities": list(s.required_capabilities or []),
            "retryLimit": int(s.retry_limit or 0),
            "retryDelayMinutes": int(s.retry_delay_minutes or 5),
            "retryCount": int(s.retry_count or 0),
            "nextRetryAt": timestamp(s.next_retry_at),
            "retrying": bool(s.next_retry_at),
            "lastRunAt": timestamp(s.last_run_at), "lastTaskId": "",
            "lastError": s.last_error,
            "nextRunAt": timestamp(next_at),
            "nextRunLocal": next_local.strftime("%Y-%m-%d %H:%M") if next_local else ""}

    payload["sourceApp"] = dict(getattr(s,"source_app",None) or {})
    if administrative:
        payload.update(ownerClientId=s.owner_client_id, createdByName=s.created_by_name)
    return payload


def apply_schedule_update(s, body: dict) -> None:
    """Apply only supplied schedule fields after validating their shape and length."""
    from ..services import schedules as sch, schedule_timing
    once_edit = getattr(s, "every", "") == "once" or body.get("every") == "once"
    before_execution = schedule_timing.execution_snapshot(s) if once_edit else None
    before_timing = schedule_timing.snapshot(s)
    if "title" in body:
        s.title = str(body.get("title") or "").strip()[:200]
    if "note" in body:
        from ..services.conversation_turns import execution_instruction
        s.note = execution_instruction(body.get("note"))
    if "atHour" in body:
        s.at_hour = max(0, min(23, int(body.get("atHour") or 0)))
    if "atMinute" in body:
        s.at_minute = max(0, min(59, int(body.get("atMinute") or 0)))
    if "weekday" in body:
        s.weekday = max(1, min(7, int(body.get("weekday") or 1)))
    if "timeZone" in body:
        s.time_zone = sch.clean_time_zone(body.get("timeZone"))
    for k, f in (("assigneeId", "assignee_id"), ("assigneeType", "assignee_type"),
                 ("repoId", "repo_id"), ("ownerClientId", "owner_client_id")):
        if k in body:
            setattr(s, f, str(body.get(k) or "").strip()[:64])
    if "modelName" in body:
        s.model_name = str(body.get("modelName") or "").strip()[:300]
    # Enterprise workflow bindings remain retired from the ordinary-conversation
    # contract. Personal plugins run in the same chat through the local worker,
    # so preserve their verifiable snapshot when supplied by the editor.
    s.flow = False
    s.plugin_binding_id = ""
    try:
        if "pluginInputs" in body:
            s.plugin_inputs = sch.clean_plugin_inputs(body.get("pluginInputs"))
        # Partial updates (for example enable/disable) must not erase the
        # selected personal-plugin parameters that were saved by the editor.
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    previous_personal_key = str(getattr(s, "personal_plugin_key", "") or "")
    from ..services.schedule_run_contracts import (
        clean_personal_plugin_checksum, clean_personal_plugin_key,
        clean_personal_plugin_version, clean_personal_plugin_version_policy,
    )
    if any(key in body for key in ("personalPluginKey", "personalPluginVersionPolicy",
                                   "personalPluginVersion", "personalPluginChecksum")):
        try:
            key_supplied = "personalPluginKey" in body
            next_key = clean_personal_plugin_key(body.get(
                "personalPluginKey", getattr(s, "personal_plugin_key", "")))
            key_changed = key_supplied and next_key != previous_personal_key
            s.personal_plugin_key = next_key
            # A key-only partial update starts a new plugin snapshot. Do not
            # attach the previous plugin's pinned version/checksum to it.
            snapshot = body if key_changed else {
                "personalPluginVersionPolicy": body.get(
                    "personalPluginVersionPolicy",
                    getattr(s, "personal_plugin_version_policy", "latest")),
                "personalPluginVersion": body.get(
                    "personalPluginVersion", getattr(s, "personal_plugin_version", "")),
                "personalPluginChecksum": body.get(
                    "personalPluginChecksum", getattr(s, "personal_plugin_checksum", "")),
            }
            s.personal_plugin_version_policy = clean_personal_plugin_version_policy(
                snapshot.get("personalPluginVersionPolicy", "latest"))
            s.personal_plugin_version = clean_personal_plugin_version(
                snapshot.get("personalPluginVersion", ""))
            s.personal_plugin_checksum = clean_personal_plugin_checksum(
                snapshot.get("personalPluginChecksum", ""))
            if not s.personal_plugin_key:
                s.personal_plugin_version_policy = "latest"
                s.personal_plugin_version = ""
                s.personal_plugin_checksum = ""
            elif s.personal_plugin_version_policy == "pinned" and (
                    not s.personal_plugin_version or not s.personal_plugin_checksum):
                raise ValueError("固定个人插件版本需要同时保存版本号和校验值，请重新选择该插件")
            elif s.personal_plugin_version_policy == "latest":
                s.personal_plugin_version = ""
                s.personal_plugin_checksum = ""
            # Plugin inputs belong to the selected personal plugin. A caller
            # changing or clearing that key without an explicit replacement
            # must not leave the previous method's parameters attached to a
            # later ordinary prompt.
            if (key_changed and
                    "pluginInputs" not in body):
                s.plugin_inputs = {}
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if "requiredCapabilities" in body:
        s.required_capabilities = sch.clean_required_capabilities(
            body.get("requiredCapabilities"))
    if "retryLimit" in body:
        s.retry_limit = max(0, min(10, int(body.get("retryLimit") or 0)))
    if "retryDelayMinutes" in body:
        s.retry_delay_minutes = max(
            1, min(1440, int(body.get("retryDelayMinutes") or 5)))
    if any(key in body for key in ("assigneeId", "modelName", "requiredCapabilities",
                                   "personalPluginKey", "personalPluginVersionPolicy",
                                   "personalPluginVersion", "personalPluginChecksum")) and (
            not once_edit or before_execution != schedule_timing.execution_snapshot(s)):
        s.retry_count, s.next_retry_at = 0, None
    if "enabled" in body:
        s.enabled = bool(body.get("enabled"))
    try:
        schedule_timing.apply(s, body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    after_timing = schedule_timing.snapshot(s)
    if before_timing != after_timing and not once_edit:
        s.retry_count, s.next_retry_at = 0, None
