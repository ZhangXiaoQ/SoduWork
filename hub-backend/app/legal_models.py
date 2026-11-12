"""Deployment-local drafts, immutable publication snapshots and user receipts."""
from datetime import datetime

from sqlalchemy import DateTime, Integer, JSON, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
from .models import _uuid


class LegalDraft(Base):
    __tablename__ = "legal_draft"

    kind: Mapped[str] = mapped_column(String(16), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_by: Mapped[str] = mapped_column(String(36))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class LegalVersion(Base):
    __tablename__ = "legal_version"
    __table_args__ = (UniqueConstraint("kind", "version", name="uq_legal_kind_version"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    version: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSON)
    digest: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(16))
    effective_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    published_by: Mapped[str] = mapped_column(String(36))
    canceled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class LegalReceipt(Base):
    __tablename__ = "legal_receipt"
    __table_args__ = (UniqueConstraint("user_id", "version_id", "action", name="uq_legal_receipt"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    version_id: Mapped[str] = mapped_column(String(36), index=True)
    action: Mapped[str] = mapped_column(String(16))
    locale: Mapped[str] = mapped_column(String(32))
    digest: Mapped[str] = mapped_column(String(64))
    device_id: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
