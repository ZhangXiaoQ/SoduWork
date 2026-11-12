"""Portable SQLAlchemy models using string UUIDs and dialect-compatible JSON for SQLite and
PostgreSQL.
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    false,
    event,
    inspect,
    select,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
from .task_notification_models import TaskNotificationOutbox  # noqa: F401


def _uuid() -> str:
    return str(uuid.uuid4())


class TaskRequirementAccess(Base):
    """Source-scoped legacy requirement access; never grants Task execution rights."""
    __tablename__ = "task_requirement_access"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    source_id: Mapped[str] = mapped_column(String(36))
    principal_kind: Mapped[str] = mapped_column(String(12))
    principal_id: Mapped[str] = mapped_column(String(64))
    role: Mapped[str] = mapped_column(String(16))
    __table_args__ = (Index("ix_requirement_access_principal", "principal_kind", "principal_id"),)


class Client(Base):
    """Client registration records keyed by device, with optional user_ref ownership."""
    __tablename__ = "client"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # Device identifier.
    name: Mapped[str | None] = mapped_column(String(64), default=None)
    # Retain the legacy plaintext slot only for security migration; new authentication uses irreversible hashes.
    secret: Mapped[str | None] = mapped_column(String(64), default=None)
    secret_hash: Mapped[str] = mapped_column(String(64), default="")
    auth_state: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    auth_version: Mapped[int] = mapped_column(Integer, default=1)
    activated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    user_ref: Mapped[str | None] = mapped_column(String(64), default=None)
    platform: Mapped[str | None] = mapped_column(String(32), default=None)
    app_version: Mapped[str | None] = mapped_column(String(32), default=None)
    # Persisted x64/arm64 device architecture used to select compatible releases.
    arch: Mapped[str | None] = mapped_column(String(16), default=None, index=True)
    config: Mapped[dict] = mapped_column(JSON, default=dict)  # Per-device configuration such as mode, theme, and character.
    # Names of personally selected skills, constrained by the administrative allowlist.
    # Users choose their own enabled subset on the desktop client.
    skills: Mapped[list] = mapped_column(JSON, default=list)
    # Personal MCP connections are separate from administrator-published AppSetting.mcp_servers.
    # Inject them only into the owner's tasks; env, headers, and passwords remain write-only.
    mcp_servers: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    # Selected names from the organization MCP catalog form the task's connection allowlist.
    # Do not expose every organization connection or credential to every conversation.
    mcp_enabled: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")





    model_keys: Mapped[dict] = mapped_column(JSON, default=dict)
    # Personal model definitions containing providerId, name, and label.
    models: Mapped[list] = mapped_column(JSON, default=list)






    agent_models: Mapped[dict] = mapped_column(JSON, default=dict)
    # Use the task owner's Git/Gerrit identity for local commits; see services/code_creds.py.
    git_creds: Mapped[dict] = mapped_column(JSON, default=dict)
    # Persist the client's configured work root so unattended dispatch can resolve paths.
    # See services/workdirs.py.
    work_root: Mapped[str] = mapped_column(String(400), default="")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ModelProvider(Base):
    """Behavior and constraints for this operation."""
    __tablename__ = "model_provider"

    id: Mapped[str] = mapped_column(String(48), primary_key=True)      # company / openai / deepseek…
    name: Mapped[str] = mapped_column(String(64), default="")
    # Use openai-compat for compatible gateways; Anthropic and Google use their own protocols.
    kind: Mapped[str] = mapped_column(String(24), default="openai-compat")
    base_url: Mapped[str] = mapped_column(String(400), default="")
    api_key: Mapped[str] = mapped_column(String(400), default="")     # Organization credential, never returned in API responses.
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)      # Built-in definition: may be disabled but not deleted.
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    note: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ModelDef(Base):
    """Selectable model definition; built-ins ship with the product, administrators add shared
    entries, and clients store personal entries.
    """
    __tablename__ = "model_def"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    provider_id: Mapped[str] = mapped_column(String(48), index=True, default="")
    name: Mapped[str] = mapped_column(String(160), default="")         # Model identifier sent to the gateway.
    label: Mapped[str] = mapped_column(String(80), default="")         # User-facing model name.
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)       # Available for user selection.
    ctx_window: Mapped[int] = mapped_column(Integer, default=0)        # Zero means unknown.
    # Output type determines chat, image, or video selection; media models must not appear as ordinary chat models.
    modality: Mapped[str] = mapped_column(String(16), default="chat", server_default="chat")
    # Media invocation path and defaults; credentials remain on the provider.
    config: Mapped[dict] = mapped_column(
        JSON, default=dict, server_default="{}", nullable=False)
    note: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Task(Base):
    """Shared task model for local, imported, and dispatched tasks, distinguished by origin."""
    __tablename__ = "task"
    __table_args__ = (Index("ix_task_owner_state_updated", "owner_client_id", "status", "updated_at", "id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # Imported tasks without a binding remain ownerless in the unassigned pool.
    # Preparation and execution share the same Task identity.
    kind: Mapped[str] = mapped_column(String(24), default="requirement", server_default="requirement")
    acceptance_criteria: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    triage_stage: Mapped[str] = mapped_column(String(24), default="ready", server_default="ready")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    shared_org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    automation_schedule_id: Mapped[str | None] = mapped_column(String(36), default=None)
    requirement_version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    requirement_content: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    legacy_requirements: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    owner_client_id: Mapped[str | None] = mapped_column(String(64), ForeignKey("client.id"), index=True, default=None)
    # Execution authority belongs to the account that received this task, not
    # whichever account next signs in on the same physical device.
    owner_user_id: Mapped[str | None] = mapped_column(String(36), index=True, default=None)
    title: Mapped[str] = mapped_column(String(200), default="未命名")
    source: Mapped[str] = mapped_column(String(120), default="")
    note: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="todo")  # todo|doing|done|cancel
    urgent: Mapped[bool | None] = mapped_column(Boolean, default=None)
    important: Mapped[bool | None] = mapped_column(Boolean, default=None)
    handler: Mapped[str] = mapped_column(String(8), default="me")  # Legacy handler field, currently fixed to me.
    result: Mapped[str] = mapped_column(Text, default="")          # Completion-output description used in receipts.
    # Source attribution.
    origin: Mapped[str] = mapped_column(String(32), default="local", index=True)  # local|dispatch|<integration.type>
    # Legacy databases may retain flow_id physically; plugin workflows replace its ORM mapping.
    integration_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)  # Integration that supplied the imported task.
    external_id: Mapped[str | None] = mapped_column(String(128), default=None)
    external_actor: Mapped[str | None] = mapped_column(String(128), default=None)  # External assignee retained for later binding of unassigned work.
    external_url: Mapped[str | None] = mapped_column(String(512), default=None)
    external_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    # Task priority, deadline, tags, creator, and assignee metadata.
    # Legacy adoption supplies missing fields; versioned databases use Alembic migrations.
    priority: Mapped[str] = mapped_column(String(16), default="normal")  # low|normal|high|critical
    # Planned schedule baseline: start_at and due_at.
    start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    # Actual execution timestamps recorded on active/completed transitions and available for correction.
    actual_start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    actual_end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    created_by: Mapped[str | None] = mapped_column(String(36), default=None)        # Creator user ID.
    created_by_name: Mapped[str] = mapped_column(String(64), default="")            # Creator display-name snapshot.
    assignee_user_id: Mapped[str | None] = mapped_column(String(36), default=None)  # Assigned or responsible user.
    # Requester identity used to send completion receipts to the person who raised the work.
    # Internal requesters use requester_user_id and receive direct client notifications.
    # External requesters use name/contact details; completion is relayed through the registrar.
    # When creator and assignee differ, default the requester to the creator unless explicitly specified.
    requester_user_id: Mapped[str | None] = mapped_column(String(36), default=None)
    requester_name: Mapped[str] = mapped_column(String(64), default="")             # Requester display name for internal or external requests.
    requester_contact: Mapped[str] = mapped_column(String(200), default="")         # External email, phone, or ticket reference; empty for internal requesters.
    recur: Mapped[str | None] = mapped_column(String(16), default=None)             # Recurrence: daily, weekly, monthly, or None.
    recur_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)  # Next recurrence deadline.
    remind_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)  # Time for a prominent desktop reminder.
    reminded: Mapped[bool | None] = mapped_column(Boolean, default=False)            # Reminder-delivered flag to prevent duplicate alerts.
    progress: Mapped[list] = mapped_column(JSON, default=list)                       # Progress entries with at, status, and optional text.
    # Responsibility domain used to prefer qualified owners before balancing load within that domain.
    domain_id: Mapped[str] = mapped_column(String(64), default="")                   # Domain ID; empty falls back to role-based load balancing.
    # Work scenarios describe the work category independently of permissions and executors.
    # Snapshot methods, capability requirements, and acceptance standards so catalog edits do not rewrite existing tasks.
    work_scenario_key: Mapped[str] = mapped_column(String(80), default="", index=True)
    work_scenario_name: Mapped[str] = mapped_column(String(100), default="")
    work_routing: Mapped[dict] = mapped_column(JSON, default=dict)
    # Team inbox tasks may remain unassigned in a department or responsibility pool.
    # An ownerless task with pool_org_id is claimable; claiming sets the client owner and clears pool_org_id.
    pool_org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    # The task creator reviews AI delivery. Files use attachments; service or website results use artifact_url.
    artifact_url: Mapped[str] = mapped_column(String(600), default="")               # Accessible output URL such as a website, preview, or pull request.
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    reviewed_by: Mapped[str | None] = mapped_column(String(36), default=None)        # Reviewer user ID.
    reviewed_by_name: Mapped[str] = mapped_column(String(64), default="")            # Reviewer display-name snapshot.
    # Project task dependencies determine sequential or parallel execution.
    project_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)  # Associated project.
    # Target code repository, resolved through repo_binding for imported issues.
    # An empty repo_id falls back to the project's first fully configured repository; explicit selection takes precedence.
    repo_id: Mapped[str] = mapped_column(String(36), default="")
    # Preserve the external repository's original identifier even when no mapping exists.
    # Administrators need this identifier to resolve unassigned issues.
    ext_repo: Mapped[str] = mapped_column(String(200), default="")



    ms_auto: Mapped[bool] = mapped_column(Boolean, default=False)
    deps: Mapped[list] = mapped_column(JSON, default=list)          # Prerequisite task IDs; all must complete before the task is ready.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class TaskOwnershipChanged(ValueError):
    """A device changed accounts after this operation loaded its identity."""


@event.listens_for(Task, "before_insert")
def _freeze_task_owner_on_insert(mapper, connection, task):
    # Always derive this server-side; TaskCreate must never choose its owner.
    current_user = connection.scalar(select(Client.user_ref).where(
        Client.id == task.owner_client_id)) if task.owner_client_id else None
    session = inspect(task).session
    key = inspect(Client).identity_key_from_primary_key((task.owner_client_id,))
    loaded = session.identity_map.get(key) if session and task.owner_client_id else None
    if loaded is not None and "user_ref" in inspect(loaded).dict:
        if str(loaded.user_ref or "") != str(current_user or ""):
            raise TaskOwnershipChanged("执行设备的登录账号已变更，请刷新后重试")
    task.owner_user_id = current_user


@event.listens_for(Task, "before_update")
def _freeze_task_owner_on_transfer(mapper, connection, task):
    if inspect(task).attrs.owner_client_id.history.has_changes():
        _freeze_task_owner_on_insert(mapper, connection, task)


class Project(Base):
    """Project grouping for tasks sharing a goal, with dependencies controlling execution order."""
    __tablename__ = "project"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(160), default="未命名工程")
    desc: Mapped[str] = mapped_column(Text, default="")
    # Store a project group and repository URL, such as a development tool and its repository.
    # Use grp to avoid the SQL keyword GROUP; legacy adoption adds it through db._WANT_COLUMNS.
    group: Mapped[str] = mapped_column("grp", String(64), default="")
    repo_url: Mapped[str] = mapped_column(String(512), default="")
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    owner_user_id: Mapped[str | None] = mapped_column(String(36), default=None)
    status: Mapped[str] = mapped_column(String(16), default="active")  # active|done|archived
    created_by: Mapped[str | None] = mapped_column(String(36), default=None)
    # Optional linked project in a managed execution service.
    # Without a link, dispatch uses the execution workspace's default project context.
    ext_project_id: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Repo(Base):
    """A code repository within a project. Store local_dir relative to each device's configured
    workspace and resolve absolute paths at dispatch. Keep repository credentials outside this
    business record.
    """
    __tablename__ = "repo"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(String(36), index=True)
    # A catalog repository can be reused by several project-specific branch mappings.
    source_repository_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    # Repository purpose: backend, frontend, mobile, infra, or other.
    kind: Mapped[str] = mapped_column(String(16), default="other")
    git_url: Mapped[str] = mapped_column(String(512), default="")
    default_branch: Mapped[str] = mapped_column(String(120), default="main")
    local_dir: Mapped[str] = mapped_column(String(200), default="")   # Directory relative to the configured workspace.
    note: Mapped[str] = mapped_column(Text, default="")               # Startup and test instructions included in the AI dispatch context.
    # Merge and deployment configuration. server_dir remains for legacy same-host deployments.
    # Normal Runner checks and merges use an independent clean checkout; new projects need not set server_dir.
    server_dir: Mapped[str] = mapped_column(String(400), default="")
    merge_branch: Mapped[str] = mapped_column(String(120), default="")   # Target merge branch; empty disables merging.
    # AI working directory for automatic local execution, separate from the clean merge checkout.
    # AI edits must not dirty server_dir and interfere with merging.
    # Interactive clients resolve their own workspace paths; unattended dispatch uses this configured directory.
    # An empty directory excludes the repository from automatic batching with an explanatory reason.
    ai_work_dir: Mapped[str] = mapped_column(String(400), default="")

    deploy_targets: Mapped[list] = mapped_column(JSON, default=list)
    # Repository development overrides: branch, selftest, screenshot, and extra instructions.
    # Store explicit overrides only; omitted values inherit app_setting.dev_flow_default.
    # Test commands and screenshot requirements vary by repository.
    # Configuration supports environment-specific exceptions without source changes.
    dev_flow: Mapped[dict] = mapped_column(JSON, default=dict)



    scm: Mapped[str] = mapped_column(String(16), default="git")
    gerrit_base: Mapped[str] = mapped_column(String(300), default="")  # Gerrit instance base URL.
    # Keyword-based repository routing.
    # When explicit repo_binding lookup misses, match title/description keywords to candidate repositories.
    # Rank candidates by route_priority before applying layer signals.
    # Dispatch only when routing resolves to one repository; leave ambiguous cases for manual assignment.
    route_keywords: Mapped[list] = mapped_column(JSON, default=list)
    route_layer: Mapped[str] = mapped_column(String(16), default="")   # Empty values derive the layer from kind.
    route_priority: Mapped[int] = mapped_column(Integer, default=0)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class RepoBinding(Base):
    """Explicit mapping from an external repository identifier to Repo. Match external identifiers
    case-insensitively; leave unmapped issues unassigned rather than guessing a target.
    """
    __tablename__ = "repo_binding"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    integration_id: Mapped[str] = mapped_column(String(36), index=True)
    external_repo: Mapped[str] = mapped_column(String(200), index=True)
    repo_id: Mapped[str] = mapped_column(String(36))          # SoduWork Repo.id
    note: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Milestone(Base):
    """One delivery milestone within a planned task. Persist progress outside runtime memory so
    resumed sessions retain context. Reuse execution/workspace references across rounds;
    parallel milestones require separate repositories to avoid conflicting edits.
    """
    __tablename__ = "milestone"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    seq: Mapped[int] = mapped_column(Integer, default=0)          # User-editable milestone order.
    title: Mapped[str] = mapped_column(String(300), default="")
    accept: Mapped[str] = mapped_column(Text, default="")         # Acceptance criteria for deciding whether the round is complete.
    repo_id: Mapped[str] = mapped_column(String(36), default="")  # Target repository; empty inherits the task default.
    # planned: pending; doing: executing; done: accepted; failed: rejected; skipped: explicitly omitted.
    status: Mapped[str] = mapped_column(String(16), default="planned")
    rounds: Mapped[int] = mapped_column(Integer, default=0)       # Execution-round count; stop for human input after two unsuccessful rounds.
    parallel_ok: Mapped[bool] = mapped_column(Boolean, default=False)
    # Source task linked to this milestone when batching work.
    # Batching avoids repeatedly loading the same repository context.
    # A batch shares one execution, workspace, and session.
    # Each source issue retains its own milestone, commit, acceptance, and traceability.
    # Propagate acceptance to the linked source task; empty means no batch source.
    src_task_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    # Per-stage executor and model overrides. Empty values inherit the task's dispatch selection.
    # Store these on the existing milestone rather than introducing a duplicate stage identity.
    agent_id: Mapped[str] = mapped_column(String(64), default="")   # Executor identifier, such as local:pi or a managed agent ID.
    agent_type: Mapped[str] = mapped_column(String(16), default="")  # agent | squad
    model: Mapped[str] = mapped_column(String(120), default="")      # Model override for this milestone.
    note: Mapped[str] = mapped_column(Text, default="")           # Round summary or rejection reason.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(),
                                                onupdate=func.now())


class Integration(Base):
    """External integration instance used by the shared aggregation framework."""
    __tablename__ = "integration"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    type: Mapped[str] = mapped_column(String(32), default="generic")
    name: Mapped[str] = mapped_column(String(64))
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    ingest_token: Mapped[str | None] = mapped_column(String(64), default=None, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    cursor: Mapped[dict] = mapped_column(JSON, default=dict)
    # Latest pull result, or latest receipt time for push/webhook integrations.
    last_pull_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_pull_ok: Mapped[bool | None] = mapped_column(Boolean, default=None)
    last_pull_error: Mapped[str | None] = mapped_column(String(512), default=None)
    last_pull_count: Mapped[int] = mapped_column(Integer, default=0)
    # Keep repository-catalog health separate from issue/task pull health.
    repository_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    repository_sync_ok: Mapped[bool | None] = mapped_column(Boolean, default=None)
    repository_sync_error: Mapped[str | None] = mapped_column(String(512), default=None)
    repository_sync_count: Mapped[int] = mapped_column(Integer, default=0)
    last_ingest_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Release(Base):
    """Renderer OTA release manifest for files stored under releases/<version>/."""
    __tablename__ = "release"

    version: Mapped[str] = mapped_column(String(32), primary_key=True)
    channel: Mapped[str] = mapped_column(String(16), default="stable", index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    files: Mapped[list] = mapped_column(JSON, default=list)  # [{path, sha256}]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ClientRelease(Base):
    """Immutable full-client installer, separate from renderer Release assets."""
    __tablename__ = "client_release"
    __table_args__ = (
        # Allow multiple installer formats for the same target and version.
        # Each format has one immutable artifact identity.
        UniqueConstraint("channel", "platform", "arch", "version", "artifact_name",
                         name="uq_client_release_target_artifact"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    version: Mapped[str] = mapped_column(String(32), index=True)
    channel: Mapped[str] = mapped_column(String(16), default="stable", index=True)
    platform: Mapped[str] = mapped_column(String(16), default="win32", index=True)
    arch: Mapped[str] = mapped_column(String(16), default="x64", index=True)
    artifact_name: Mapped[str] = mapped_column(String(160))
    artifact_path: Mapped[str] = mapped_column(String(400))
    artifact_size: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    signature: Mapped[str] = mapped_column(String(128))
    key_id: Mapped[str] = mapped_column(String(64))
    notes: Mapped[str] = mapped_column(Text, default="")
    mandatory: Mapped[bool] = mapped_column(Boolean, default=False)
    min_version: Mapped[str] = mapped_column(String(32), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_by: Mapped[str] = mapped_column(String(36), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ClientUpdateAttempt(Base):
    """One device upgrade attempt, including command delivery, download, installation, and startup
    confirmation.
    """
    __tablename__ = "client_update_attempt"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    client_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("client.id", ondelete="CASCADE"), index=True)
    release_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("client_release.id"), index=True)
    requested_by: Mapped[str] = mapped_column(String(36), default="")
    current_version: Mapped[str] = mapped_column(String(32), default="")
    target_version: Mapped[str] = mapped_column(String(32))
    state: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(String(600), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class IntegrationBinding(Base):
    """Mapping from an external assignee to a SoduWork client."""
    __tablename__ = "integration_binding"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    integration_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("integration.id", ondelete="CASCADE"), index=True
    )
    external_actor: Mapped[str] = mapped_column(String(128))
    client_id: Mapped[str] = mapped_column(String(64), ForeignKey("client.id"))


# Organizational structure, users, and RBAC roles.

class OrgUnit(Base):
    """Department-tree node; an empty parent_id identifies a root department."""
    __tablename__ = "org_unit"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(64))
    parent_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)  # Use a soft reference to avoid self-referencing foreign-key migration constraints.
    sort: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Role(Base):
    """Configurable permission set; system roles cannot be deleted."""
    __tablename__ = "role"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(64))
    permissions: Mapped[list] = mapped_column(JSON, default=list)  # Permission keys defined in permissions.py.
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Position(Base):
    """Professional profile describing expertise independently of role permissions, workflow
    responsibilities, and executors.
    """
    __tablename__ = "position"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    name: Mapped[str] = mapped_column(String(48))
    category: Mapped[str] = mapped_column(String(40), default="")
    description: Mapped[str] = mapped_column(String(400), default="")
    competencies: Mapped[list] = mapped_column(JSON, default=list)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)   # Built-in professional role, not deletable.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WorkScenario(Base):
    """Work-scenario catalog connecting intent with professional profiles, capabilities, plugins,
    and delivery standards. Organization entries may override platform keys; scenarios reference
    capabilities rather than specific runtimes.
    """
    __tablename__ = "work_scenario"
    __table_args__ = (
        UniqueConstraint("org_id", "key", name="uq_work_scenario_org_key"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    key: Mapped[str] = mapped_column(String(80), index=True)
    name: Mapped[str] = mapped_column(String(100))
    category: Mapped[str] = mapped_column(String(40), default="")
    description: Mapped[str] = mapped_column(String(500), default="")
    position_ids: Mapped[list] = mapped_column(JSON, default=list)
    intent_hints: Mapped[list] = mapped_column(JSON, default=list)
    required_capabilities: Mapped[list] = mapped_column(JSON, default=list)
    default_plugin_key: Mapped[str] = mapped_column(String(100), default="")
    output_contract: Mapped[dict] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Domain(Base):
    """Responsibility-domain catalog independent of professional roles. Users may own multiple
    domains; assignment prefers matching domain expertise. Seeded examples remain editable and
    removable.
    """
    __tablename__ = "domain"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(48))
    sort: Mapped[int] = mapped_column(Integer, default=0)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)   # Business domains are removable by default, including seeded entries.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# Legacy FlowTemplate and TaskWorkflow definitions have moved to plugin automation tables.
# WorkflowRun and NodeRun retain runtime state; legacy definition tables are no longer read or written.


class TaskEvent(Base):
    """Task lifecycle audit event, including creation, advancement, rejection, and reassignment."""
    __tablename__ = "task_event"
    __table_args__ = (Index("ix_task_event_timeline", "task_id", "at", "id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    # Namespaced plugin and release events can exceed 24 characters.
    # Use 64 characters, matching workflow events, to avoid PostgreSQL transaction failures.
    kind: Mapped[str] = mapped_column(String(64))
    detail: Mapped[dict] = mapped_column(JSON, default=dict)  # {fromStage,toStage,fromOwner,toOwner,note}
    actor: Mapped[str] = mapped_column(String(64), default="")  # Actor display name.
    # SQLite CURRENT_TIMESTAMP has insufficient precision for ordered task events.
    # Random UUID ordering within one second can make clients display an earlier state.
    # Use application UTC microseconds; retain the server default for legacy SQL writers.
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now())


class TaskComment(Base):
    """Shared human and AI comment thread. Mentions notify colleagues or request AI responses and
    work.
    """
    __tablename__ = "task_comment"
    __table_args__ = (Index("ix_task_comment_timeline", "task_id", "created_at", "id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    author_kind: Mapped[str] = mapped_column(String(8), default="user")  # user|ai|system
    author_id: Mapped[str | None] = mapped_column(String(36), default=None)  # User ID for a human actor.
    author_name: Mapped[str] = mapped_column(String(64), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    mentions: Mapped[list] = mapped_column(JSON, default=list)  # [{type:'user'|'ai', id, name}]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class AiSchedule(Base):
    """Behavior and constraints for this operation."""
    __tablename__ = "ai_schedule"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str] = mapped_column(String(200), default="")      # 每次建出来的任务标题
    note: Mapped[str] = mapped_column(Text, default="")              # 交代给 AI 的正文
    # Rhythm values are hourly, daily, weekly, monthly, custom, or once.
    every: Mapped[str] = mapped_column(String(16), default="daily")
    # Bounded iCalendar-style recurrence text used when every == custom.
    custom_rule: Mapped[str] = mapped_column(Text, default="", server_default="")
    run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    # Server-owned consumption marker; manual execution does not consume the appointment.
    once_fired: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    at_hour: Mapped[int] = mapped_column(Integer, default=9)
    at_minute: Mapped[int] = mapped_column(Integer, default=0)
    weekday: Mapped[int] = mapped_column(Integer, default=1)         # Legacy weekly value, 1=Monday … 7=Sunday.
    weekdays: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    month_days: Mapped[list] = mapped_column(JSON, default=list, server_default="[]")
    month_day_policy: Mapped[str] = mapped_column(String(16), default="skip", server_default="skip")
    start_date: Mapped[str | None] = mapped_column(String(10), default=None)
    end_date: Mapped[str | None] = mapped_column(String(10), default=None)
    # IANA 时区（如 Asia/Shanghai）。计划时刻属于创建者，不属于 Hub 所在服务器；
    # 否则同一条“每天 18:00”换到 UTC 容器后会变成另一个真实时刻。
    time_zone: Mapped[str] = mapped_column(String(64), default="Asia/Shanghai")
    # Agent workspace, using the same contract as manual dispatch.
    assignee_id: Mapped[str] = mapped_column(String(64), default="")     # Runtime key, for example local:pi.
    assignee_type: Mapped[str] = mapped_column(String(16), default="agent")
    model_name: Mapped[str] = mapped_column(String(300), default="")
    repo_id: Mapped[str] = mapped_column(String(36), default="")         # Documentation and research tasks may omit a repository.
    flow: Mapped[bool] = mapped_column(Boolean, default=False)           # Whether to follow the development workflow.
    # Empty selects direct assignment; otherwise start from an immutable plugin binding.
    # Store ordinary declared form inputs here; secrets use SecretReference bindings.
    plugin_binding_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    plugin_inputs: Mapped[dict] = mapped_column(JSON, default=dict)
    source_app: Mapped[dict] = mapped_column(JSON, default=dict)
    # For personal plugins, Hub stores identity and verifiable version metadata; the owner's Runner resolves the body.
    # Pin a version or explicitly select latest; MCP uses the conversation grant ticket bridge.
    # Mutually exclusive with plugin_binding_id: organization bindings run workflows, personal plugins supply direct-task context.
    personal_plugin_key: Mapped[str] = mapped_column(String(64), default="", index=True)
    # Only verifiable metadata reaches Hub; the plugin body remains device-local.
    # Existing rows keep latest semantics, while new clients pin a version + checksum.
    personal_plugin_version_policy: Mapped[str] = mapped_column(
        String(16), default="latest")
    personal_plugin_version: Mapped[str] = mapped_column(String(40), default="")
    personal_plugin_checksum: Mapped[str] = mapped_column(String(64), default="")
    # Freeze the capability contract independently of the selected Runner or agent runtime.
    # An offline preferred machine must not silently remove browser, computer, or office requirements.
    required_capabilities: Mapped[list] = mapped_column(JSON, default=list)
    retry_limit: Mapped[int] = mapped_column(Integer, default=2)
    retry_delay_minutes: Mapped[int] = mapped_column(Integer, default=5)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None)

    owner_client_id: Mapped[str] = mapped_column(String(36), default="")  # Client that owns the task.
    owner_user_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_task_id: Mapped[str] = mapped_column(String(36), default="")
    last_error: Mapped[str] = mapped_column(String(400), default="")
    created_by: Mapped[str | None] = mapped_column(String(36), default=None)
    created_by_name: Mapped[str] = mapped_column(String(64), default="")
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


@event.listens_for(AiSchedule, "before_insert")
def _freeze_schedule_owner_on_insert(mapper, connection, schedule):
    # Creation and explicit device transfers use the same trusted identity
    # check as tasks. A later login never changes an existing schedule owner.
    _freeze_task_owner_on_insert(mapper, connection, schedule)


@event.listens_for(AiSchedule, "before_update")
def _freeze_schedule_owner_on_transfer(mapper, connection, schedule):
    if inspect(schedule).attrs.owner_client_id.history.has_changes():
        _freeze_schedule_owner_on_insert(mapper, connection, schedule)


class AiScheduleRun(Base):
    """One immutable receipt for every scheduled, manual or retry attempt.

    AiSchedule.last_* remains the compact card summary. This ledger is the
    audit truth: accepting work is only running; completion is reconciled
    later from the related task or workflow run.
    """
    __tablename__ = "ai_schedule_run"

    __table_args__ = (
        Index("ix_ai_schedule_run_schedule_started", "schedule_id", "started_at"),
        Index("uq_ai_schedule_run_idempotency_key", "idempotency_key", unique=True),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    # One stable identity per timer/retry occurrence. Manual clicks get a fresh identity.
    # The unique index is the final cross-process guard after a lease expires or a Hub crashes.
    idempotency_key: Mapped[str] = mapped_column(
        String(180), default=lambda: "manual:" + _uuid())
    schedule_id: Mapped[str] = mapped_column(String(36), index=True)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    owner_client_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    owner_user_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    task_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    workflow_run_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    trigger: Mapped[str] = mapped_column(String(16), default="timer")
    state: Mapped[str] = mapped_column(String(24), default="starting", index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    error: Mapped[str] = mapped_column(String(1200), default="")
    receipt: Mapped[dict] = mapped_column(JSON, default=dict)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc),
        server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None)


@event.listens_for(AiScheduleRun, "before_insert")
def _freeze_schedule_run_owner(mapper, connection, run):
    previous = getattr(run, "_frozen_execution_owner", None)
    if previous is not None:
        # A substrate rollback can remove a flushed receipt. execute_one
        # reinserts that same occurrence to retain its failure evidence.
        run.owner_client_id, run.owner_user_id = previous
        return
    parent = connection.execute(select(AiSchedule.owner_client_id, AiSchedule.owner_user_id).where(
        AiSchedule.id == run.schedule_id)).first()
    session = inspect(run).session
    key = inspect(AiSchedule).identity_key_from_primary_key((run.schedule_id,))
    loaded = session.identity_map.get(key) if session else None
    if parent and loaded is not None:
        state = inspect(loaded).dict
        if all(name in state for name in ("owner_client_id", "owner_user_id")) and (
                str(loaded.owner_client_id or ""), str(loaded.owner_user_id or "")) != (
                str(parent.owner_client_id or ""), str(parent.owner_user_id or "")):
            raise TaskOwnershipChanged("自动化的归属已变更，请刷新后重试")
    # Orphaned or mismatched history has no proven account owner.
    run.owner_user_id = parent.owner_user_id if parent and parent.owner_client_id == run.owner_client_id else None
    run._frozen_execution_owner = (run.owner_client_id, run.owner_user_id)


class AppSetting(Base):
    """Editable runtime setting, including LLM configuration. Redact secret values when reading
    settings.
    """
    __tablename__ = "app_setting"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class DailyReport(Base):
    """Periodic report keyed by its local start date and period type. Shared facts and generation
    contracts support additional period types.
    """
    __tablename__ = "daily_report"
    __table_args__ = (
        UniqueConstraint("user_id", "period_type", "date", name="uq_personal_report_period"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    user_name: Mapped[str] = mapped_column(String(64), default="")
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)  # Scope filter for leaders viewing subordinate reports.
    period_type: Mapped[str] = mapped_column(String(16), default="daily", index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)      # Local period start date in YYYY-MM-DD format.
    content: Mapped[str] = mapped_column(Text, default="")         # Report body.
    source: Mapped[str] = mapped_column(String(16), default="template")  # llm | template
    done_count: Mapped[int] = mapped_column(Integer, default=0)
    progress_count: Mapped[int] = mapped_column(Integer, default=0)
    active_count: Mapped[int] = mapped_column(Integer, default=0)  # Number of tasks active during the day.
    items: Mapped[list] = mapped_column(JSON, default=list)        # Source snapshot retained for review and regeneration.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class AuditLog(Base):
    """Administrative audit record of actor, time, target, and action; complements task lifecycle
    events.
    """
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    actor_id: Mapped[str | None] = mapped_column(String(36), default=None)
    actor_name: Mapped[str] = mapped_column(String(64), default="")
    actor_org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)  # Used for scope filtering.
    action: Mapped[str] = mapped_column(String(48), index=True)   # Action key, for example task.dispatch or client.assign.
    target_type: Mapped[str] = mapped_column(String(24), default="")
    target_id: Mapped[str | None] = mapped_column(String(64), default=None)
    target_label: Mapped[str] = mapped_column(String(200), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class Attachment(Base):
    """Auditable task material or evidence. Binary contents live in object storage; this record
    retains provenance.
    """
    __tablename__ = "attachment"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    filename: Mapped[str] = mapped_column(String(256), default="")
    content_type: Mapped[str] = mapped_column(String(128), default="application/octet-stream")
    size: Mapped[int] = mapped_column(Integer, default=0)
    storage_key: Mapped[str] = mapped_column(String(400), default="")   # Object storage key or local file name.
    backend: Mapped[str] = mapped_column(String(16), default="local")   # minio|local
    uploaded_by: Mapped[str | None] = mapped_column(String(64), default=None)  # Uploading device or user.
    # Roles: input for human materials, process for execution evidence, output for deliverables, verification for checks and reviews.
    role: Mapped[str] = mapped_column(String(24), default="input", index=True)
    # New evidence binds to an exact execution, workflow, and node. Historical records may use a time-window display fallback.
    source_ref: Mapped[str] = mapped_column(String(180), default="", index=True)
    workflow_run_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    node_run_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    evidence_meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MateMessage(Base):
    """????? @ ??????????

    ???????????????????????????? Hub ????
    ?????????????????????
    """
    __tablename__ = "mate_message"
    __table_args__ = (
        UniqueConstraint("sender_id", "recipient_id", "client_message_id",
                         name="uq_mate_message_client_id"),
        Index("ix_mate_message_recipient", "recipient_id", "created_at"),
        Index("ix_mate_message_sender", "sender_id", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    sender_id: Mapped[str] = mapped_column(String(36), index=True)
    recipient_id: Mapped[str] = mapped_column(String(36), index=True)
    client_message_id: Mapped[str] = mapped_column(String(64), default="")
    conversation_id: Mapped[str] = mapped_column(String(180), default="")
    text: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="accepted", index=True)
    attachments: Mapped[list] = mapped_column(JSON, default=list)
    website: Mapped[dict] = mapped_column(JSON, default=dict)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class TeamDailyReport(Base):
    """Bottom-up team report combining direct members and child teams. Personal reports retain
    source evidence; source changes reset generated reports and invalidate confirmation
    fingerprints.
    """
    __tablename__ = "team_daily_report"
    __table_args__ = (
        UniqueConstraint("org_id", "period_type", "date", name="uq_team_report_period"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str] = mapped_column(String(36), index=True)
    org_name: Mapped[str] = mapped_column(String(64), default="")
    period_type: Mapped[str] = mapped_column(String(16), default="daily", index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    content: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(16), default="template")  # llm | template
    status: Mapped[str] = mapped_column(String(16), default="generated", index=True)
    summary: Mapped[dict] = mapped_column(JSON, default=dict)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    source_refs: Mapped[list] = mapped_column(JSON, default=list)
    source_digest: Mapped[str] = mapped_column(String(64), default="")
    confirmed_by: Mapped[str] = mapped_column(String(36), default="")
    confirmed_by_name: Mapped[str] = mapped_column(String(64), default="")
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    leader_note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class User(Base):
    """Administrator identity. Super administrators have full access; other administrators are
    limited to their department subtree.
    """
    __tablename__ = "app_user"  # Avoid the SQL reserved word user as the table name.

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256), default="")  # pbkdf2$iter$salt$hash
    display_name: Mapped[str] = mapped_column(String(64), default="")
    email: Mapped[str | None] = mapped_column(String(254), default=None)
    email_normalized: Mapped[str | None] = mapped_column(String(254), default=None, unique=True)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    avatar_url: Mapped[str] = mapped_column(Text, default="")
    account_deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    role_id: Mapped[str | None] = mapped_column(String(36), default=None)
    is_super: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    auth_version: Mapped[int] = mapped_column(Integer, default=1)
    # Professional positions are independent of permissions; multiple positions support workflow routing.
    positions: Mapped[list] = mapped_column(JSON, default=list)   # List of Position IDs.
    # Multiple responsibility domains support preferred assignment.
    domains: Mapped[list] = mapped_column(JSON, default=list)     # List of Domain IDs.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class AIUsageEvent(Base):
    """Enterprise AI usage ledger across agents, users, and scenarios. Idempotency keys and
    monotonic cumulative updates prevent duplicate charges from repeated heartbeats and offline
    retries.
    """
    __tablename__ = "ai_usage_event"
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uq_ai_usage_event_idempotency"),
        Index("ix_ai_usage_user_time", "billing_user_id", "occurred_at"),
        Index("ix_ai_usage_org_time", "org_id", "occurred_at"),
        Index("ix_ai_usage_user_created", "billing_user_id", "created_at"),
        Index("ix_ai_usage_org_created", "org_id", "created_at"),
        Index("ix_ai_usage_created_at", "created_at"),
        Index("ix_ai_usage_source", "source_type", "source_id"),
        Index("ix_ai_usage_agent_time", "agent_key", "occurred_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    idempotency_key: Mapped[str] = mapped_column(String(240))
    org_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    billing_user_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    actor_user_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    client_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    runner_id: Mapped[str] = mapped_column(String(80), default="", index=True)
    source_type: Mapped[str] = mapped_column(String(32), default="chat", index=True)
    source_id: Mapped[str] = mapped_column(String(180), default="", index=True)
    # Client-reported conversation title, including later renames, for the recent AI work list.
    # Runner tasks fall back to the task title.
    source_title: Mapped[str] = mapped_column(String(200), default="")
    conversation_id: Mapped[str] = mapped_column(String(180), default="", index=True)
    task_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    workflow_run_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    node_run_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    agent_key: Mapped[str] = mapped_column(String(60), default="", index=True)
    provider: Mapped[str] = mapped_column(String(60), default="", index=True)
    model: Mapped[str] = mapped_column(String(160), default="", index=True)
    credential_scope: Mapped[str] = mapped_column(String(32), default="unknown")
    billing_mode: Mapped[str] = mapped_column(String(32), default="unknown")

    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    reasoning_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    input_includes_cache: Mapped[bool] = mapped_column(Boolean, default=False)
    requests: Mapped[int] = mapped_column(Integer, default=0)
    turns: Mapped[int] = mapped_column(Integer, default=0)
    steps: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    cost_microusd: Mapped[int] = mapped_column(BigInteger, default=0)
    currency: Mapped[str] = mapped_column(String(8), default="USD")
    quality: Mapped[str] = mapped_column(String(20), default="reported", index=True)
    raw_usage: Mapped[dict] = mapped_column(JSON, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class AIUsageDaily(Base):
    """Per-calendar-day deltas derived from a cumulative usage event.

    ``AIUsageEvent`` intentionally stores the latest cumulative counters for an
    idempotency key.  This companion table stores the positive increments that
    arrived on each Beijing calendar day so a long-running conversation cannot
    move yesterday's usage into today's chart when it reports a new total.
    """
    __tablename__ = "ai_usage_daily"
    __table_args__ = (
        UniqueConstraint(
            "usage_event_id", "day_key", "dimension_key", name="uq_ai_usage_daily_dimension"),
        Index("ix_ai_usage_daily_day", "day_key"),
        Index("ix_ai_usage_daily_user_day", "billing_user_id", "day_key"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    usage_event_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("ai_usage_event.id", ondelete="CASCADE"))
    # ISO date in Asia/Shanghai (YYYY-MM-DD); string ordering is portable across
    # SQLite and PostgreSQL and keeps range predicates index-friendly.
    day_key: Mapped[str] = mapped_column(String(10), nullable=False)
    # Freeze attribution on the increment. A later model/account switch must
    # never relabel historical usage through the mutable cumulative event.
    dimension_key: Mapped[str] = mapped_column(String(64), default="", server_default="")
    # Immutable platform-budget attribution; legacy/unknown increments stay charged.
    quota_scope: Mapped[str] = mapped_column(String(16), default="platform", server_default="platform")
    billing_user_id: Mapped[str] = mapped_column(String(36), default="", server_default="")
    org_id: Mapped[str] = mapped_column(String(36), default="", server_default="")
    client_id: Mapped[str] = mapped_column(String(64), default="", server_default="")
    agent_key: Mapped[str] = mapped_column(String(60), default="", server_default="")
    provider: Mapped[str] = mapped_column(String(60), default="", server_default="")
    model: Mapped[str] = mapped_column(String(160), default="", server_default="")
    source_type: Mapped[str] = mapped_column(String(32), default="chat", server_default="chat")
    cost_known: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    input_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    output_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    reasoning_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    total_tokens: Mapped[int] = mapped_column(BigInteger, default=0)
    requests: Mapped[int] = mapped_column(Integer, default=0)
    turns: Mapped[int] = mapped_column(Integer, default=0)
    steps: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    cost_microusd: Mapped[int] = mapped_column(BigInteger, default=0)
    currency: Mapped[str] = mapped_column(String(8), default="USD")
    is_baseline: Mapped[bool] = mapped_column(Boolean, default=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class IdentityProvider(Base):
    """Identity provider configuration, initially OIDC. Store only the client-secret environment
    variable name; successful discovery is required before enabling the provider.
    """
    __tablename__ = "identity_provider"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    key: Mapped[str] = mapped_column(String(48), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(100))
    protocol: Mapped[str] = mapped_column(String(16), default="oidc")
    issuer: Mapped[str] = mapped_column(String(500), default="")
    client_id: Mapped[str] = mapped_column(String(300), default="")
    client_secret_env: Mapped[str] = mapped_column(String(120), default="")
    redirect_uri: Mapped[str] = mapped_column(String(700), default="")
    scopes: Mapped[list] = mapped_column(JSON, default=lambda: ["openid", "profile", "email"])
    claim_mapping: Mapped[dict] = mapped_column(JSON, default=dict)
    allowed_domains: Mapped[list] = mapped_column(JSON, default=list)
    jit_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    default_org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    default_role_id: Mapped[str | None] = mapped_column(String(36), default=None)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    probe_state: Mapped[str] = mapped_column(String(16), default="untested", index=True)
    probe_message: Mapped[str] = mapped_column(String(500), default="")
    discovery: Mapped[dict] = mapped_column(JSON, default=dict)
    probed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class IdentityLink(Base):
    """Stable OIDC user binding by issuer and subject, independent of username changes."""
    __tablename__ = "identity_link"
    __table_args__ = (
        UniqueConstraint("provider_id", "subject", name="uq_identity_link_subject"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    provider_id: Mapped[str] = mapped_column(String(36), index=True)
    subject: Mapped[str] = mapped_column(String(300))
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    email: Mapped[str] = mapped_column(String(300), default="")
    claims_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
