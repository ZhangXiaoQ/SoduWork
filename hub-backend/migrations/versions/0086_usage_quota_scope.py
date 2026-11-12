"""Freeze server-attested personal funding on new daily usage increments."""
from alembic import op
import sqlalchemy as sa

revision = "0086_usage_quota_scope"
down_revision = "0085_merge_public_schedule"
branch_labels = None
depends_on = None


def upgrade():
    # Never infer old funding from mutable/client-reported event metadata.
    op.add_column("ai_usage_daily", sa.Column("quota_scope", sa.String(16),
        nullable=False, server_default="platform"))


def downgrade():
    if op.get_bind().execute(sa.text(
            "SELECT 1 FROM ai_usage_daily WHERE quota_scope = 'personal' LIMIT 1")).first():
        raise RuntimeError("Cannot discard personal funding attribution; restore the matching backup")
    with op.batch_alter_table("ai_usage_daily") as batch:
        batch.drop_column("quota_scope")
