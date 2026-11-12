"""Versioned legal publications; migrating never publishes legal content."""
from alembic import op
import sqlalchemy as sa

revision = "0080_legal_publications"
down_revision = "0079_native_discovery"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("legal_draft",
        sa.Column("kind", sa.String(16), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("updated_by", sa.String(36), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()))
    op.create_table("legal_version",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("version", sa.String(64), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("effective_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("published_by", sa.String(36), nullable=False),
        sa.Column("canceled_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("kind", "version", name="uq_legal_kind_version"))
    op.create_index("ix_legal_version_kind", "legal_version", ["kind"])
    op.create_index("ix_legal_version_effective_at", "legal_version", ["effective_at"])
    op.create_table("legal_receipt",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("version_id", sa.String(36), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("locale", sa.String(32), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("device_id", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "version_id", "action", name="uq_legal_receipt"))
    op.create_index("ix_legal_receipt_user_id", "legal_receipt", ["user_id"])
    op.create_index("ix_legal_receipt_version_id", "legal_receipt", ["version_id"])


def downgrade():
    op.drop_table("legal_receipt")
    op.drop_table("legal_version")
    op.drop_table("legal_draft")
