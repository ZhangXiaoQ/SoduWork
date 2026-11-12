"""Limit recurring schedules to an optional inclusive local-date range."""
from alembic import op
import sqlalchemy as sa

revision = "0081_schedule_date_range"
down_revision = "0080_merge_public_discovery"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("ai_schedule", sa.Column("start_date", sa.Date(), nullable=True))
    op.add_column("ai_schedule", sa.Column("end_date", sa.Date(), nullable=True))


def downgrade():
    op.drop_column("ai_schedule", "end_date")
    op.drop_column("ai_schedule", "start_date")
