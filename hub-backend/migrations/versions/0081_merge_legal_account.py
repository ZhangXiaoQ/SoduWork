"""Join legal publication and account lifecycle migrations without rewriting either branch."""

revision = "0081_merge_legal_account"
down_revision = ("0080_legal_publications", "0080_account_lifecycle")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
