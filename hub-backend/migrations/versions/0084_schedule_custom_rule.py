"""Add bounded custom recurrence text to AI schedules."""
from alembic import op
import sqlalchemy as sa


revision = "0084_schedule_custom_rule"
down_revision = "0083_schedule_timing_rules"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_schedule", sa.Column("custom_rule", sa.Text(), nullable=False, server_default=""))


def downgrade() -> None:
    if op.get_bind().scalar(sa.text("SELECT count(*) FROM ai_schedule WHERE every = 'custom'")):
        raise RuntimeError("Convert custom schedules explicitly before dropping their recurrence rules")
    op.drop_column("ai_schedule", "custom_rule")
