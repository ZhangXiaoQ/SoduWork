"""Task attachment metadata and authorization APIs. services.storage handles binary data in MinIO
or local storage.
"""
import asyncio
import logging
import os
import uuid

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import get_session
from ..deps import current_ai_client, current_client
from ..models import Attachment, Client, Task
from ..schemas import attachment_to_api
from ..services import attachment_ownership, resource_access, storage, task_access, task_requirements

router = APIRouter(prefix="/api/v1", tags=["attachments"])

log = logging.getLogger("uvicorn.error")


def _task_attachment_api(attachment: Attachment, task: Task, client: Client) -> dict:
    out = attachment_to_api(attachment)
    out["canDelete"] = bool(
        task_access.is_owner(task, client) or attachment_ownership.owns_attachment(attachment, client))
    return out


def _safe_name(name: str) -> str:
    name = (name or "file").replace("/", "_").replace("\\", "_").strip()
    return name[:200] or "file"


def _upload_size(file: UploadFile) -> int:
    """Measure uploads through the underlying file handle without loading a spooled file into
    memory again.
    """
    size = getattr(file, "size", None)
    if isinstance(size, int) and size >= 0:
        return size
    handle = file.file
    pos = handle.tell()
    handle.seek(0, os.SEEK_END)
    size = handle.tell()
    handle.seek(pos)
    return int(size)


async def _save_attachment(session: AsyncSession, client: Client, target_id: str,
                           file: UploadFile, *, source_ref: str = "",
                           evidence_meta: dict | None = None) -> Attachment:
    max_bytes = get_settings().attach_max_mb * 1024 * 1024
    size = _upload_size(file)
    if size > max_bytes:
        raise HTTPException(status_code=413, detail=f"文件超过 {get_settings().attach_max_mb}MB 上限")
    if size <= 0:
        raise HTTPException(status_code=400, detail="空文件")
    fn = _safe_name(file.filename)
    ct = file.content_type or "application/octet-stream"
    attachment = Attachment(
        id=str(uuid.uuid4()), task_id=target_id, filename=fn, content_type=ct,
        size=size, uploaded_by=client.id, role="input", source_ref=source_ref,
        evidence_meta=attachment_ownership.metadata(client, evidence_meta))
    key = f"att/{target_id}/{attachment.id}/{fn}"
    attachment.storage_key = key
    # Stream storage writes on a worker thread so large uploads do not block the event loop.
    # Avoid copying the entire upload into memory.
    file.file.seek(0)
    attachment.backend = await asyncio.to_thread(
        storage.put_stream, key, file.file, size, ct)
    session.add(attachment)
    await session.commit()
    await session.refresh(attachment)
    return attachment


@router.get("/tasks/{tid}/attachments")
async def list_attachments(
    tid: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    task = await task_requirements.get(session, client, tid)
    res = await session.execute(
        select(Attachment).where(Attachment.task_id == tid).order_by(Attachment.created_at)
    )
    rows = res.scalars().all()
    # Execution-view access grants visibility to all attachments; evaluate it once per request.
    # Do not repeat can_view, company_access, and readable_sources queries for every attachment.
    # Use fine-grained checks only when attachment visibility exceeds execution-detail access.
    if await task_access.can_view(session, client, task):
        return [_task_attachment_api(a, task, client) for a in rows]
    return [_task_attachment_api(a, task, client) for a in rows
            if await task_requirements.can_read_attachment(session, client, task, a)]


@router.post("/tasks/{tid}/attachments")
async def upload_attachment(
    tid: str,
    file: UploadFile = File(...),
    client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
    purpose: str = Form(default=""),
    field: str = Form(default="description"),
    sequence: int = Form(default=0),
    criterion_text: str = Form(default="", alias="criterionText"),
):
    task = await task_requirements.get(session, client, tid)
    if not await task_requirements.can_manage(session, client, task):
        raise HTTPException(403, "Requirement is read-only")
    purpose = purpose if isinstance(purpose, str) else ""
    field = field if isinstance(field, str) else "description"
    sequence = sequence if isinstance(sequence, int) else 0
    criterion_text = criterion_text if isinstance(criterion_text, str) else ""
    if purpose not in {"", "requirement_input"} or field not in {"description", "acceptance"}:
        raise HTTPException(400, "附件归属字段不正确")
    if purpose != "requirement_input" and not await task_access.can_view(session, client, task):
        raise HTTPException(403, "只能上传需求输入材料")
    evidence = ({"kind": "requirement_input", "field": field,
                 "sequence": max(0, min(sequence, 999)), "criterionText": criterion_text[:1000]}
                if purpose == "requirement_input" else {})
    saved = await _save_attachment(session, client, tid, file, evidence_meta=evidence)
    return _task_attachment_api(saved, task, client)


@router.get("/attachments/{aid}")
async def download_attachment(
    aid: str,
    ticket: str = Query(default=""),
    mode: str = Query(default=""),
    session: AsyncSession = Depends(get_session),
):
    """Download through a short-lived capability URL.

    The ticket is purpose-bound to one attachment and expires after ten minutes.
    """
    if not ticket or not resource_access.verify_attachment(aid, ticket):
        raise HTTPException(status_code=401, detail="附件访问凭证无效或已过期")
    a = await session.get(Attachment, aid)
    if a is None:
        raise HTTPException(status_code=404, detail="附件不存在")
    evidence = a.evidence_meta or {}
    if a.role == "handoff" and evidence.get("contentRef"):
        from ..services import conversation_content
        content = conversation_content.stream(evidence["contentRef"], evidence["contentOwner"], evidence["contentRecord"])
        # Validate endpoint availability before sending successful response headers.
        first = await anext(content)
        async def endpoint_stream():
            try:
                yield first
                async for part in content:
                    yield part
            finally:
                await content.aclose()
        response_stream = endpoint_stream()
    else:
        try:
            stream = await asyncio.to_thread(storage.open_stream, a.storage_key, a.backend)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="附件文件已丢失")
        response_stream = storage.iter_stream(stream)
    # Inline only passive bitmap images; force SVG and HTML downloads even when labeled image/*.
    # Sandbox all attachment responses to prevent same-origin script execution when opened directly.
    inline = resource_access.is_inline_image(a.content_type) or (
        mode == "preview" and resource_access.is_inline_preview(a.content_type))
    disp = "inline" if inline else "attachment"
    from urllib.parse import quote
    return StreamingResponse(
        response_stream, media_type=a.content_type or "application/octet-stream",
        headers={
            "Content-Disposition": f"{disp}; filename*=UTF-8''{quote(a.filename)}",
            "Content-Length": str(max(0, int(a.size or 0))),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Referrer-Policy": "no-referrer",
            # Electron pages use file:// and therefore have a different origin.
            # The unguessable, short-lived URL is the authorization boundary.
            "Cross-Origin-Resource-Policy": "cross-origin",
        },
    )


@router.post("/attachments/{aid}/access")
async def refresh_attachment_access(
    aid: str, client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Issue a fresh short-lived URL for an attachment the device may access."""
    a = await session.get(Attachment, aid)
    if a is None:
        raise HTTPException(status_code=404, detail="附件不存在")
    if str(a.source_ref or "").startswith(("conversation-video:", "conversation-image:")):
        allowed = attachment_ownership.owns_attachment(a, client)
    else:
        try:
            task = await task_requirements.get(session, client, a.task_id)
            allowed = await task_requirements.can_read_attachment(session, client, task, a)
        except HTTPException:
            allowed = False
    if not allowed:
        raise HTTPException(status_code=404, detail="附件不存在")
    return {"ok": True, "attachmentId": a.id,
            "url": resource_access.attachment_url(a.id)}


@router.post("/conversations/{conversation_id}/images")
async def generate_conversation_image(
    conversation_id: str, request: Request, body: dict = Body(...),
    client: Client = Depends(current_ai_client), session: AsyncSession = Depends(get_session),
):
    from ..services import image_generation, model_transport
    if not conversation_id.strip() or len(conversation_id) > 120:
        raise HTTPException(status_code=400, detail="会话标识无效")
    try:
        return await model_transport.until_disconnect(request, image_generation.generate_image(
            session, client, body, conversation_id=conversation_id))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/conversations/{conversation_id}/media")
async def list_conversation_media(
    conversation_id: str, client: Client = Depends(current_client),
    session: AsyncSession = Depends(get_session),
):
    """Return completed media artifacts so a disconnected client can recover."""
    import re
    ref = re.sub(
        r"[^A-Za-z0-9_.-]", "_", str(conversation_id or "")[:120]
    ).strip("._-") or "conversation"
    rows = (await session.execute(
        select(Attachment).where(
            Attachment.source_ref.in_(["conversation-video:" + ref, "conversation-image:" + ref]),
            attachment_ownership.owner_clause(client),
            Attachment.role == "output",
        ).order_by(Attachment.created_at.desc()).limit(50)
    )).scalars().all()
    items = []
    for row in rows:
        mime = str(row.content_type or "").split(";", 1)[0].lower()
        if not mime.startswith(("video/", "image/")) or not row.storage_key or int(row.size or 0) <= 0:
            continue
        meta = dict(row.evidence_meta or {})
        items.append({
            "kind": "image" if mime.startswith("image/") else "video", "attachmentId": row.id,
            "filename": row.filename, "mimeType": mime, "size": row.size,
            "url": resource_access.attachment_url(row.id),
            "duration": meta.get("duration"),
            "aspectRatio": meta.get("aspectRatio"),
            "resolution": meta.get("resolution"),
            "fps": meta.get("fps"),
        })
    return {"ok": True, "conversationId": ref, "items": items}


@router.delete("/attachments/{aid}")
async def delete_attachment(
    aid: str, client: Client = Depends(current_client), session: AsyncSession = Depends(get_session)
):
    a = await session.get(Attachment, aid)
    if a is None:
        raise HTTPException(status_code=404, detail="附件不存在")
    if str(a.source_ref or "").startswith(("conversation-video:", "conversation-image:")):
        if not attachment_ownership.owns_attachment(a, client):
            raise HTTPException(status_code=404, detail="附件不存在")
    else:
        task = await task_requirements.get(session, client, a.task_id)
        can_delete = task_access.is_owner(task, client) or attachment_ownership.owns_attachment(a, client)
        if not can_delete or not await task_requirements.can_read_attachment(session, client, task, a):
            raise HTTPException(404, "Attachment not found")
    if a.role == "handoff":
        raise HTTPException(409, "会话交接工作包是恢复凭据，不能单独删除")
    # Commit metadata deletion before deleting the stored object.
    # This prevents live metadata from referencing a missing object if the transaction fails.
    # A leftover storage object can be reclaimed later without breaking user-visible attachment records.
    storage_key, backend = a.storage_key, a.backend
    await session.delete(a)
    await session.commit()
    try:
        await asyncio.to_thread(storage.delete, storage_key, backend)
    except Exception as exc:  # noqa: BLE001  Storage cleanup failure does not undo the committed deletion.
        log.warning("attachment object cleanup failed (%s): %s",
                    aid, type(exc).__name__)
    return {"ok": True}
