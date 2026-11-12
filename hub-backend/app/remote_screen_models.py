"""Short-lived, read-only remote screen grants."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class RemoteScreenGrant(Base):
    __tablename__ = "remote_screen_grant"
    __table_args__ = (
        Index("ix_remote_screen_grant_viewer_state", "viewer_client_id", "state"),
        Index("ix_remote_screen_grant_source_state", "source_client_id", "state"),
        Index("ix_remote_screen_grant_expires", "expires_at"),
        Index("ix_remote_screen_source_state_expiry", "source_client_id", "state", "expires_at"),
    )

    id: Mapped[str] = mapped_column(String(80), primary_key=True, default=_uuid)
    owner_user_id: Mapped[str] = mapped_column(String(36), index=True)
    viewer_client_id: Mapped[str] = mapped_column(String(64), index=True)
    source_client_id: Mapped[str] = mapped_column(String(64), index=True)
    state: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    permission: Mapped[str] = mapped_column(String(16), default="view")
    can_control: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    stopped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    ticket_hash: Mapped[str] = mapped_column(String(64), default="")

