"""Limit recurring schedules to an optional inclusive local-date range."""
from alembic import op
import sqlalchemy as sa

revision = "0081_schedule_date_range"
down_revision = "0080_merge_public_discovery"
branch_labels = None
depends_on = None


def upgrade():
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("ai_schedule")}
    for name in ("start_date", "end_date"):
        if name not in columns:
            op.add_column("ai_schedule", sa.Column(name, sa.String(10), nullable=True))


def downgrade():
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("ai_schedule")}
    if "weekdays" in columns:
        # The calendar-timing branch owns these shared columns too.
        return
    for name in ("start_date", "end_date"):
        if name in columns and op.get_bind().scalar(sa.text(
                f"SELECT count(*) FROM ai_schedule WHERE {name} IS NOT NULL")):
            raise RuntimeError("Convert calendar-bounded schedules explicitly before dropping their timing fields")
    for name in ("end_date", "start_date"):
        if name in columns:
            op.drop_column("ai_schedule", name)
