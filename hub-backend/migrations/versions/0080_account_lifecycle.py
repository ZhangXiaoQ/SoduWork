"""Distinguish explicit account lifecycle intent from legacy source snapshots."""
from alembic import op
import sqlalchemy as sa

revision = "0080_account_lifecycle"
down_revision = "0079_native_discovery"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("account_conversation", sa.Column(
        "lifecycle_revision", sa.Integer(), nullable=False, server_default="0"))


def downgrade():
    op.drop_column("account_conversation", "lifecycle_revision")
