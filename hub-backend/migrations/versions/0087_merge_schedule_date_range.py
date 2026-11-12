"""Join date-range history and retain dates in the current string contract."""
from alembic import op
import sqlalchemy as sa

revision = "0087_merge_schedule_date_range"
down_revision = ("0086_usage_quota_scope", "0081_schedule_date_range")
branch_labels = None
depends_on = None


def upgrade():
    columns = sa.inspect(op.get_bind()).get_columns("ai_schedule")
    date_columns = [column for column in columns
                    if column["name"] in ("start_date", "end_date")
                    and isinstance(column["type"], sa.Date)]
    if not date_columns:
        return
    with op.batch_alter_table("ai_schedule") as batch:
        for column in date_columns:
            batch.alter_column(column["name"], existing_type=column["type"],
                               type_=sa.String(10), existing_nullable=True,
                               postgresql_using=f'{column["name"]}::text')


def downgrade():
    # Both parent branches accept ISO calendar-date strings; keep their data.
    pass
