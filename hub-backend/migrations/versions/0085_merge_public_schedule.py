"""Join the public schema and upstream schedule history without rewriting either."""

revision = "0085_merge_public_schedule"
down_revision = ("0080_merge_public_discovery", "0084_schedule_custom_rule")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
