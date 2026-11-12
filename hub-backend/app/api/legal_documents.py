"""Platform-only publishing and authenticated, explicit client responses."""
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_session
from ..deps import authenticated_client, require_perm
from ..legal_models import LegalVersion
from ..services import legal_publications as legal
from .account_profile import AccountRoute

class LegalRoute(AccountRoute):
    conflict_code = "LEGAL_CONFLICT"
    conflict_message = "草稿已发生变化，请重新加载并核对后再发布"


admin_router = APIRouter(prefix="/api/v1/admin/legal-documents", tags=["legal administration"], route_class=LegalRoute)
router = APIRouter(prefix="/api/v1/client-auth", tags=["legal documents"], route_class=AccountRoute)


async def platform_admin(user=Depends(require_perm("identity.manage"))):
    if not user.is_super:
        raise HTTPException(403, "需要超级管理员权限")
    return user


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DraftBody(StrictBody):
    revision: int = Field(ge=0)
    draft: dict


class PublishBody(StrictBody):
    revision: int = Field(ge=1)
    effectiveAt: datetime | None = None

    @field_validator("effectiveAt")
    @classmethod
    def timezone_required(cls, value):
        if value is not None and value.tzinfo is None:
            raise ValueError("生效时间必须包含时区")
        return value


class ResponseBody(StrictBody):
    kind: Literal["terms", "privacy"]
    revisionId: str = Field(min_length=1, max_length=36)
    action: Literal["accept", "notice"]
    locale: str = Field(min_length=2, max_length=32)


@admin_router.get("/{kind}")
async def state(kind: str, session: AsyncSession = Depends(get_session), admin=Depends(platform_admin)):
    return await legal.admin_state(session, kind)


@admin_router.put("/{kind}/draft")
async def draft(kind: str, body: DraftBody, session: AsyncSession = Depends(get_session), admin=Depends(platform_admin)):
    result = await legal.save_draft(session, kind, body.revision, body.draft, admin)
    legal.audit_event(session, admin, "legal.draft.save", kind, {"revision": result["revision"]})
    await session.commit()
    return result


@admin_router.post("/{kind}/publish")
async def publish(kind: str, body: PublishBody, session: AsyncSession = Depends(get_session), admin=Depends(platform_admin)):
    result = await legal.publish(session, kind, body.revision, body.effectiveAt, admin)
    await session.commit()
    return result


@admin_router.get("/versions/{version_id}")
async def version(version_id: str, session: AsyncSession = Depends(get_session), admin=Depends(platform_admin)):
    row = await session.get(LegalVersion, version_id)
    if row is None:
        raise HTTPException(404, "版本不存在")
    return legal.version_info(row, True)


@admin_router.post("/versions/{version_id}/cancel")
async def cancel(version_id: str, session: AsyncSession = Depends(get_session), admin=Depends(platform_admin)):
    await legal.cancel(session, version_id, admin)
    await session.commit()
    return {"ok": True}


@router.get("/me/legal-status")
async def status(session: AsyncSession = Depends(get_session), client=Depends(authenticated_client)):
    return await legal.status(session, client.user_ref)


@router.post("/me/legal-response")
async def respond(body: ResponseBody, session: AsyncSession = Depends(get_session), client=Depends(authenticated_client)):
    await legal.respond(session, client.user_ref, client.id, body.kind, body.revisionId, body.action, body.locale)
    await session.commit()
    return {"ok": True, **await legal.status(session, client.user_ref)}


@router.get("/legal-documents/versions/{version_id}")
async def public_version(version_id: str, session: AsyncSession = Depends(get_session)):
    row = await session.get(LegalVersion, version_id)
    if row is None or row.canceled_at or legal.aware(row.effective_at) > legal.now():
        raise HTTPException(404, "版本不存在")
    return {"documents": legal.public_documents(row)}
