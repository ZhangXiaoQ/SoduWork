"""Add calendar-aware timing fields while keeping legacy weekday schedules readable."""
from alembic import op
import sqlalchemy as sa

revision = "0083_schedule_timing_rules"
down_revision = "0082_endpoint_content"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_schedule", sa.Column("weekdays", sa.JSON(), nullable=False, server_default="[]"))
    op.add_column("ai_schedule", sa.Column("month_days", sa.JSON(), nullable=False, server_default="[]"))
    op.add_column("ai_schedule", sa.Column("month_day_policy", sa.String(length=16), nullable=False, server_default="skip"))
    op.add_column("ai_schedule", sa.Column("start_date", sa.String(length=10), nullable=True))
    op.add_column("ai_schedule", sa.Column("end_date", sa.String(length=10), nullable=True))
    connection = op.get_bind()
    schedule = sa.table(
        "ai_schedule",
        sa.column("id", sa.String(length=36)),
        sa.column("every", sa.String(length=16)),
        sa.column("weekday", sa.Integer),
        sa.column("weekdays", sa.JSON()),
    )
    # Keep migration work bounded by weekday groups, not by the number of plans.
    for day in range(1, 8):
        match = schedule.c.weekday == day
        if day == 1:
            match = sa.or_(schedule.c.weekday.is_(None), schedule.c.weekday <= 1)
        elif day == 7:
            match = schedule.c.weekday >= 7
        connection.execute(
            schedule.update().where(schedule.c.every == "weekly", match).values(weekdays=[day])
        )


def downgrade() -> None:
    if op.get_bind().scalar(sa.text("SELECT count(*) FROM ai_schedule WHERE every = 'monthly' "
                                   "OR start_date IS NOT NULL OR end_date IS NOT NULL")):
        raise RuntimeError("Convert calendar-bounded schedules explicitly before dropping their timing fields")
    rows = op.get_bind().execute(sa.text("SELECT weekdays FROM ai_schedule WHERE every = 'weekly'"))
    import json
    for row in rows:
        days = json.loads(row[0]) if isinstance(row[0], str) else row[0]
        if days and len(days) > 1:
            raise RuntimeError("Convert multi-weekday schedules explicitly before dropping their timing fields")
    op.drop_column("ai_schedule", "end_date")
    op.drop_column("ai_schedule", "start_date")
    op.drop_column("ai_schedule", "month_day_policy")
    op.drop_column("ai_schedule", "month_days")
    op.drop_column("ai_schedule", "weekdays")
