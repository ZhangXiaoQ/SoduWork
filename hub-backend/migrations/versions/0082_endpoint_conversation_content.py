"""Add endpoint content references without deleting any historical body."""
from alembic import op
import sqlalchemy as sa

revision = "0082_endpoint_content"
down_revision = "0081_merge_legal_account"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("account_conversation", sa.Column("storage_mode", sa.String(16), nullable=False, server_default="legacy"))
    op.add_column("account_conversation", sa.Column("content_ref", sa.JSON(), nullable=True))
    op.add_column("account_conversation", sa.Column("message_count", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("personal_conversation_relay", sa.Column("content_ref", sa.JSON(), nullable=True))


def downgrade():
    # Removing references after a body migration would orphan the only copy.
    connection = op.get_bind()
    count = connection.execute(sa.text("SELECT COUNT(*) FROM account_conversation WHERE content_ref IS NOT NULL")).scalar()
    relay_count = connection.execute(sa.text("SELECT COUNT(*) FROM personal_conversation_relay WHERE content_ref IS NOT NULL")).scalar()
    event_refs = connection.execute(sa.text("SELECT 1 FROM automation_execution_event WHERE CAST(detail AS TEXT) LIKE '%\"contentRef\"%' LIMIT 1")).first()
    handoff_refs = connection.execute(sa.text("SELECT 1 FROM conversation_handoff WHERE CAST(options AS TEXT) LIKE '%\"contentRef\"%' OR CAST(options AS TEXT) LIKE '%\"archiveRef\"%' LIMIT 1")).first()
    message_refs = connection.execute(sa.text("SELECT 1 FROM conversation_message_receipt WHERE CAST(payload AS TEXT) LIKE '%\"contentRef\"%' LIMIT 1")).first()
    schedule_refs = connection.execute(sa.text("SELECT 1 FROM ai_schedule_run WHERE CAST(receipt AS TEXT) LIKE '%\"contentRef\"%' LIMIT 1")).first()
    if count or relay_count or event_refs or handoff_refs or message_refs or schedule_refs:
        raise RuntimeError("Restore endpoint content to the legacy schema before downgrading")
    op.drop_column("account_conversation", "content_ref")
    op.drop_column("account_conversation", "message_count")
    op.drop_column("account_conversation", "storage_mode")
    op.drop_column("personal_conversation_relay", "content_ref")
