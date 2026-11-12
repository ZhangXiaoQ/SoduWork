"""Durable account-owned conversation projections.

The source device remains the only device allowed to append to a conversation.
Other devices receive a read projection through the Hub. Native execution
requires a separate authenticated admission claimed by the source device;
the projection itself never grants transcript write access.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class PersonalConversationRelay(Base):
    """Admission receipt only; native execution remains in the source session.

    A claimed command is never automatically replayed. The source PC must
    acknowledge its durable local receipt; transcript sync owns result state.
    """
    __tablename__ = "personal_conversation_relay"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_user_id: Mapped[str] = mapped_column(String(64), index=True)
    requester_client_id: Mapped[str] = mapped_column(String(64))
    source_client_id: Mapped[str] = mapped_column(String(64), index=True)
    conversation_id: Mapped[str] = mapped_column(String(180))
    active_conversation_id: Mapped[str | None] = mapped_column(String(180), unique=True)
    request_id: Mapped[str] = mapped_column(String(80))
    request_hash: Mapped[str] = mapped_column(String(64))
    source_epoch: Mapped[str] = mapped_column(String(180))
    source_revision: Mapped[int] = mapped_column(Integer)
    instruction: Mapped[str] = mapped_column(Text)
    content_ref: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    phase: Mapped[str] = mapped_column(String(16), default="prepared")
    reason: Mapped[str] = mapped_column(String(500), default="")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (UniqueConstraint("requester_client_id", "request_id"),)


class AccountConversationCursor(Base):
    """Per-account monotonic directory revision allocator."""

    __tablename__ = "account_conversation_cursor"

    owner_user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class AccountConversation(Base):
    """The Hub's current metadata projection for one source session."""

    __tablename__ = "account_conversation"
    __table_args__ = (
        UniqueConstraint(
            "owner_user_id", "source_client_id", "source_session_id",
            name="uq_account_conversation_source",
        ),
        Index("ix_account_conversation_owner_revision", "owner_user_id", "revision", "id"),
        Index("ix_account_conversation_owner_updated", "owner_user_id", "updated_at"),
    )

    id: Mapped[str] = mapped_column(String(180), primary_key=True, default=_uuid)
    owner_user_id: Mapped[str] = mapped_column(String(36), index=True)
    source_client_id: Mapped[str] = mapped_column(String(64), index=True)
    source_session_id: Mapped[str] = mapped_column(String(180))
    task_projection_id: Mapped[str] = mapped_column(String(120), default="", server_default="")
    source_device_name: Mapped[str] = mapped_column(String(120), default="")
    source_epoch: Mapped[str] = mapped_column(String(180), default="")
    source_revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    source_digest: Mapped[str] = mapped_column(String(64), default="")
    storage_mode: Mapped[str] = mapped_column(String(16), default="legacy", server_default="legacy")
    content_ref: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    message_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    state: Mapped[str] = mapped_column(String(24), default="idle")
    archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    deleted: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    # Zero denotes a source snapshot predating explicit account lifecycle intent.
    lifecycle_revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc), server_default=func.now(),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(),
    )


class AccountConversationMessage(Base):
    """Append/update projection rows with per-conversation cursors."""

    __tablename__ = "account_conversation_message"
    __table_args__ = (
        Index("ix_account_conversation_message_conversation_revision", "conversation_id", "revision"),
        Index("ix_account_conversation_message_conversation_position", "conversation_id", "position"),
    )

    id: Mapped[str] = mapped_column(String(240), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(180), ForeignKey("account_conversation.id", ondelete="CASCADE"), index=True,
    )
    position: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(),
    )
    done: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    deleted: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    revision: Mapped[int] = mapped_column(Integer, default=0, server_default="0")



class ConversationProject(Base):
    """Account sidebar organization, independent of execution permissions."""
    __tablename__ = "account_conversation_project"
    owner_user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    # Store only conversation identities, never local folders or credentials.
    members: Mapped[str] = mapped_column(Text, default="[]")
