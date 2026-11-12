"""Domain models for environments, immutable outputs, approvals, deployment, and plugin execution.
Use stable IDs without cascading foreign keys; domain services enforce consistency and preserve
audit history independently of task synchronization.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (JSON, BigInteger, Boolean, DateTime, Index, Integer, String, Text,
                        UniqueConstraint, func, text)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _uuid() -> str:
    return str(uuid.uuid4())


class Environment(Base):
    """Reusable organizational environment with configurable classification and promotion rules."""
    __tablename__ = "automation_environment"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    key: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(80))
    # Open classification for display and filtering only; it does not control release behavior.
    tier: Mapped[str] = mapped_column(String(24), default="custom", index=True)
    description: Mapped[str] = mapped_column(String(400), default="")
    runner_selector: Mapped[dict] = mapped_column(JSON, default=dict)
    approval_policy_id: Mapped[str] = mapped_column(String(36), default="")
    acceptance_policy_id: Mapped[str] = mapped_column(String(36), default="")
    # Declarative promotion settings: autoStart, requires, requiresApproval, and marksDelivery.
    # Store required environment keys rather than database IDs so imported workflows can be rebound.
    promotion_policy: Mapped[dict] = mapped_column(JSON, default=dict)
    health_checks: Mapped[list] = mapped_column(JSON, default=list)
    rollback: Mapped[dict] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ScmRepository(Base):
    """Canonical repository discovered from GitLab or Gerrit."""

    __tablename__ = "automation_scm_repository"
    __table_args__ = (
        UniqueConstraint("integration_id", "external_id",
                         name="uq_scm_repository_integration_external"),
        Index("ix_scm_repository_provider_name", "provider", "full_name"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    integration_id: Mapped[str] = mapped_column(String(36), index=True)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    provider: Mapped[str] = mapped_column(String(24), index=True)
    external_id: Mapped[str] = mapped_column(String(200))
    full_name: Mapped[str] = mapped_column(String(400), index=True)
    display_name: Mapped[str] = mapped_column(String(200), default="")
    clone_url: Mapped[str] = mapped_column(String(700), default="")
    ssh_url: Mapped[str] = mapped_column(String(700), default="")
    web_url: Mapped[str] = mapped_column(String(700), default="")
    default_branch: Mapped[str] = mapped_column(String(160), default="main")
    visibility: Mapped[str] = mapped_column(String(24), default="")
    archived: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    fingerprint: Mapped[str] = mapped_column(String(64), default="", index=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class TaskCodeTarget(Base):
    """Immutable code target captured when a task first enters an engineering workflow."""

    __tablename__ = "automation_task_code_target"
    __table_args__ = (
        UniqueConstraint("task_id", name="uq_task_code_target_task"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    project_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    repo_id: Mapped[str] = mapped_column(String(36), index=True)
    source_repository_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    repo_name: Mapped[str] = mapped_column(String(200), default="")
    scm: Mapped[str] = mapped_column(String(24), default="git")
    git_url: Mapped[str] = mapped_column(String(700), default="")
    base_branch: Mapped[str] = mapped_column(String(160), default="main")
    target_branch: Mapped[str] = mapped_column(String(160), default="main")
    local_dir: Mapped[str] = mapped_column(String(240), default="")
    config_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())


class ResourceLease(Base):
    """Cross-process lease with expiry and token-guarded release."""

    __tablename__ = "automation_resource_lease"
    __table_args__ = (
        UniqueConstraint("resource_kind", "resource_key",
                         name="uq_resource_lease_kind_key"),
        Index("ix_resource_lease_until", "lease_until"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    resource_kind: Mapped[str] = mapped_column(String(40), index=True)
    resource_key: Mapped[str] = mapped_column(String(300), index=True)
    owner_id: Mapped[str] = mapped_column(String(120), default="")
    token: Mapped[str] = mapped_column(String(64), default="")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    acquired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    detail: Mapped[dict] = mapped_column(JSON, default=dict)

class DeploymentTarget(Base):
    """A repository's deployment target in an environment; credentials are references only."""
    __tablename__ = "automation_deployment_target"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    repo_id: Mapped[str] = mapped_column(String(36), index=True)
    environment_id: Mapped[str] = mapped_column(String(36), index=True)
    name: Mapped[str] = mapped_column(String(100))
    provider: Mapped[str] = mapped_column(String(40), default="runner-command")
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    secret_refs: Mapped[dict] = mapped_column(JSON, default=dict)
    runner_selector: Mapped[dict] = mapped_column(JSON, default=dict)
    health_checks: Mapped[list] = mapped_column(JSON, default=list)
    rollback: Mapped[dict] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PreflightEvidence(Base):
    """A persisted, fingerprint-bound proof that an external capability was reachable.

    The subject is deliberately generic.  Repository access, deployment targets and future
    plugin/MCP capabilities all need the same rule: a successful probe is evidence only for the
    exact configuration that was tested.  Changing that configuration makes the record stale;
    it never silently remains green.
    """
    __tablename__ = "automation_preflight_evidence"
    __table_args__ = (
        UniqueConstraint("subject_kind", "subject_id", "check_kind",
                         name="uq_preflight_evidence_subject_check"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    subject_kind: Mapped[str] = mapped_column(String(32), index=True)
    subject_id: Mapped[str] = mapped_column(String(64), index=True)
    check_kind: Mapped[str] = mapped_column(String(40), index=True)
    fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    state: Mapped[str] = mapped_column(String(16), default="failed", index=True)
    summary: Mapped[str] = mapped_column(String(600), default="")
    executor_id: Mapped[str] = mapped_column(String(80), default="")
    executor_name: Mapped[str] = mapped_column(String(100), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    checked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())


class SecretReference(Base):
    """Reference a secret location such as environment variables or a vault without storing
    plaintext.
    """
    __tablename__ = "automation_secret_reference"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    name: Mapped[str] = mapped_column(String(100))
    provider: Mapped[str] = mapped_column(String(32), default="env")
    locator: Mapped[str] = mapped_column(String(500), default="")
    metadata_: Mapped[dict] = mapped_column("metadata", JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ApprovalPolicy(Base):
    """Configurable review policy whose resolved rules are snapshotted on each request."""
    __tablename__ = "automation_approval_policy"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    key: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(String(400), default="")
    rules: Mapped[dict] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ArtifactVersion(Base):
    """Immutable, reviewable delivery snapshot containing files, a URL, or a code commit."""
    __tablename__ = "automation_artifact_version"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    seq: Mapped[int] = mapped_column(Integer, default=1)
    kind: Mapped[str] = mapped_column(String(24), default="files")  # files|url|code
    source_ref: Mapped[str] = mapped_column(String(160), default="")
    commit_sha: Mapped[str] = mapped_column(String(80), default="", index=True)
    branch: Mapped[str] = mapped_column(String(160), default="")
    target: Mapped[str] = mapped_column(String(160), default="")
    checksum: Mapped[str] = mapped_column(String(64), index=True)
    url: Mapped[str] = mapped_column(String(800), default="")
    manifest: Mapped[dict] = mapped_column(JSON, default=dict)
    state: Mapped[str] = mapped_column(String(24), default="candidate", index=True)
    created_by_kind: Mapped[str] = mapped_column(String(24), default="system")
    created_by_id: Mapped[str] = mapped_column(String(64), default="")
    created_by_name: Mapped[str] = mapped_column(String(100), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ApprovalRequest(Base):
    """A review or authorization request bound to an output version."""
    __tablename__ = "automation_approval_request"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    artifact_version_id: Mapped[str] = mapped_column(String(36), index=True)
    action: Mapped[str] = mapped_column(String(32), index=True)  # review|merge|deploy
    environment_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    policy_id: Mapped[str] = mapped_column(String(36), default="")
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    required_count: Mapped[int] = mapped_column(Integer, default=1)
    policy_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(64), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class ApprovalAssignment(Base):
    """An approval assignment snapshot unaffected by later role changes."""
    __tablename__ = "automation_approval_assignment"
    __table_args__ = (
        UniqueConstraint("request_id", "user_id", name="uq_approval_assignment_user"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    request_id: Mapped[str] = mapped_column(String(36), index=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    user_name: Mapped[str] = mapped_column(String(100), default="")
    # Retain all selection reasons when a user qualifies through multiple roles.
    sources: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ApprovalDecision(Base):
    """An approver's decision; services enforce one effective decision per user and request."""
    __tablename__ = "automation_approval_decision"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    request_id: Mapped[str] = mapped_column(String(36), index=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    user_name: Mapped[str] = mapped_column(String(100), default="")
    decision: Mapped[str] = mapped_column(String(16))  # approve|reject
    note: Mapped[str] = mapped_column(String(1200), default="")
    gate_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class DeploymentRun(Base):
    """Deployment, health-check, and rollback execution record."""
    __tablename__ = "automation_deployment_run"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    artifact_version_id: Mapped[str] = mapped_column(String(36), index=True)
    environment_id: Mapped[str] = mapped_column(String(36), index=True)
    target_id: Mapped[str] = mapped_column(String(36), index=True)
    state: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=0)
    idempotency_key: Mapped[str] = mapped_column(String(160), index=True)
    runner_id: Mapped[str] = mapped_column(String(80), default="")
    commit_sha: Mapped[str] = mapped_column(String(80), default="")
    logs: Mapped[str] = mapped_column(Text, default="")
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(String(1200), default="")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Plugin(Base):
    """Stable plugin identity retained across version updates."""
    __tablename__ = "automation_plugin"
    __table_args__ = (
        # A regular org/key constraint does not protect platform plugins
        # because SQL NULL values are distinct. These scoped indexes are
        # enforced by both supported databases: PostgreSQL and SQLite.
        Index("uq_automation_plugin_platform_key", "key", unique=True,
              sqlite_where=text("org_id IS NULL"),
              postgresql_where=text("org_id IS NULL")),
        Index("uq_automation_plugin_org_key", "org_id", "key", unique=True,
              sqlite_where=text("org_id IS NOT NULL"),
              postgresql_where=text("org_id IS NOT NULL")),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    key: Mapped[str] = mapped_column(String(100), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(600), default="")
    source_kind: Mapped[str] = mapped_column(String(24), default="soduwork")
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(String(36), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PluginVersion(Base):
    """Immutable plugin snapshot, deduplicated by checksum."""
    __tablename__ = "automation_plugin_version"
    __table_args__ = (
        Index("uq_automation_plugin_version_name", "plugin_id", "version", unique=True),
        Index("uq_automation_plugin_version_checksum", "plugin_id", "checksum", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    plugin_id: Mapped[str] = mapped_column(String(36), index=True)
    version: Mapped[str] = mapped_column(String(40))
    checksum: Mapped[str] = mapped_column(String(64), index=True)
    manifest: Mapped[dict] = mapped_column(JSON, default=dict)
    workflow: Mapped[dict] = mapped_column(JSON, default=dict)
    capability_report: Mapped[dict] = mapped_column(JSON, default=dict)
    provenance: Mapped[dict] = mapped_column(JSON, default=dict)
    package_path: Mapped[str] = mapped_column(String(700), default="")
    trust_state: Mapped[str] = mapped_column(String(24), default="quarantined", index=True)
    # Publication audience is immutable with the version. Personal plugins never reach this table.
    visibility: Mapped[str] = mapped_column(String(24), default="organization")
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str] = mapped_column(String(36), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PluginPublisherKey(Base):
    """Immutable public identity used to verify detached plugin signatures."""
    __tablename__ = "automation_plugin_publisher_key"
    __table_args__ = (
        # A device may reuse one publisher identity in several organizations.
        # Platform trust remains a separate fallback scope, so neither scope
        # can accidentally overwrite or inherit the other's trust state.
        Index("uq_plugin_publisher_platform_key", "key_id", unique=True,
              sqlite_where=text("org_id IS NULL"),
              postgresql_where=text("org_id IS NULL")),
        Index("uq_plugin_publisher_org_key", "org_id", "key_id", unique=True,
              sqlite_where=text("org_id IS NOT NULL"),
              postgresql_where=text("org_id IS NOT NULL")),
        Index("ix_plugin_publisher_key_org_id", "org_id"),
        Index("ix_plugin_publisher_key_key_id", "key_id"),
        Index("ix_plugin_publisher_key_fingerprint", "fingerprint"),
        Index("ix_plugin_publisher_key_status", "status"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None)
    key_id: Mapped[str] = mapped_column(String(64))
    publisher_name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(400), default="")
    public_key: Mapped[str] = mapped_column(String(64))
    fingerprint: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="active")
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class PluginAudience(Base):
    """Who may discover or run one immutable enterprise plugin version."""
    __tablename__ = "automation_plugin_audience"
    __table_args__ = (
        UniqueConstraint("version_id", "principal_type", "principal_id",
                         name="uq_plugin_audience_version_principal"),
        Index("ix_plugin_audience_plugin", "plugin_id"),
        Index("ix_plugin_audience_version", "version_id"),
        Index("ix_plugin_audience_org", "org_id"),
        Index("ix_plugin_audience_principal", "principal_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    plugin_id: Mapped[str] = mapped_column(String(36))
    version_id: Mapped[str] = mapped_column(String(36))
    org_id: Mapped[str | None] = mapped_column(String(36), default=None)
    principal_type: Mapped[str] = mapped_column(String(24), default="user")
    principal_id: Mapped[str] = mapped_column(String(64))
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PluginInstallation(Base):
    """One employee's opt-in to use an enterprise plugin in ordinary conversations.

    Enterprise bindings continue to govern task and automation execution.  This row only controls
    whether the published capability appears in the employee's personal conversation toolbox.
    Keeping the accepted immutable version makes upgrades explicit and auditable.
    """
    __tablename__ = "automation_plugin_installation"
    __table_args__ = (
        UniqueConstraint("plugin_id", "user_id", name="uq_plugin_installation_user"),
        Index("ix_plugin_installation_plugin_id", "plugin_id"),
        Index("ix_plugin_installation_version_id", "version_id"),
        Index("ix_plugin_installation_user_id", "user_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    plugin_id: Mapped[str] = mapped_column(String(36))
    version_id: Mapped[str] = mapped_column(String(36))
    user_id: Mapped[str] = mapped_column(String(64))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # Per-user non-secret preferences declared by this immutable version.
    # Credentials stay in governed MCP/SecretReference stores.
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    setup_state: Mapped[str] = mapped_column(String(24), default="ready")
    verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None)
    installed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PluginCatalogPolicy(Base):
    """Mutable employee marketplace policy, independent from immutable versions.

    Task and automation bindings remain authoritative for governed execution.
    This policy only controls employee discovery and ordinary conversation install.
    """
    __tablename__ = "automation_plugin_catalog_policy"
    __table_args__ = (
        Index("ix_plugin_catalog_policy_category", "category"),
        Index("ix_plugin_catalog_policy_installation", "installation"),
    )

    plugin_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    category: Mapped[str] = mapped_column(String(32), default="general")
    installation: Mapped[str] = mapped_column(String(32), default="available")
    authentication: Mapped[str] = mapped_column(String(24), default="on_use")
    featured: Mapped[bool] = mapped_column(Boolean, default=False)
    cover_url: Mapped[str] = mapped_column(String(2048), default="", server_default="")
    sort: Mapped[int] = mapped_column(Integer, default=0)
    updated_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PluginRecommendation(Base):
    """One placement slot of one target on one surface (P1: compose, kind=app).

    Single source of truth for page placement, decoupled from the marketplace
    ``featured`` flag: the same app can appear in both, either, or neither.
    Display material (icon/name/description) is derived live from the target
    app, never copied here, so renames and icon changes follow automatically.
    """
    __tablename__ = "automation_plugin_recommendation"
    __table_args__ = (
        Index("ix_plugin_recommendation_surface", "surface", "enabled", "sort", "id"),
        Index("ix_plugin_recommendation_org", "org_id"),
        Index("ix_plugin_recommendation_target", "target_type", "target_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None)
    surface: Mapped[str] = mapped_column(String(24), default="compose")
    kind: Mapped[str] = mapped_column(String(24), default="app")
    target_type: Mapped[str] = mapped_column(String(24), default="plugin")
    target_id: Mapped[str] = mapped_column(String(36))
    title: Mapped[str] = mapped_column(String(120), default="")
    subtitle: Mapped[str] = mapped_column(String(240), default="")
    cover_url: Mapped[str] = mapped_column(String(2048), default="")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    updated_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class PluginEvaluationRun(Base):
    """One immutable execution attempt for a versioned publication evaluation case."""
    __tablename__ = "automation_plugin_evaluation_run"
    __table_args__ = (
        Index("ix_plugin_evaluation_latest",
              "version_id", "case_key", "created_at", "id"),
        Index("ix_plugin_evaluation_plugin", "plugin_id"),
        Index("ix_plugin_evaluation_version", "version_id"),
        Index("ix_plugin_evaluation_case", "case_key"),
        Index("ix_plugin_evaluation_org", "org_id"),
        Index("ix_plugin_evaluation_state", "state"),
        Index("ix_plugin_evaluation_verdict", "verdict"),
        Index("ix_plugin_evaluation_ref", "external_ref"),
        Index("uq_plugin_evaluation_active", "active_key", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    plugin_id: Mapped[str] = mapped_column(String(36))
    version_id: Mapped[str] = mapped_column(String(36))
    case_key: Mapped[str] = mapped_column(String(64))
    active_key: Mapped[str | None] = mapped_column(String(140), default=None)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None)
    state: Mapped[str] = mapped_column(String(24), default="queued")
    verdict: Mapped[str] = mapped_column(String(24), default="pending")
    external_ref: Mapped[str] = mapped_column(String(180), default="")
    agent_kind: Mapped[str] = mapped_column(String(100), default="")
    model: Mapped[str] = mapped_column(String(160), default="")
    case_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    executor: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(String(1200), default="")
    created_by: Mapped[str] = mapped_column(String(64), default="")
    reviewed_by: Mapped[str] = mapped_column(String(64), default="")
    review_note: Mapped[str] = mapped_column(String(1200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class PluginBinding(Base):
    """Organizational or project configuration for a plugin version; sensitive values reference
    SecretReference IDs.
    """
    __tablename__ = "automation_plugin_binding"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    plugin_id: Mapped[str] = mapped_column(String(36), index=True)
    version_id: Mapped[str] = mapped_column(String(36), index=True)
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    project_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    secret_refs: Mapped[dict] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ProjectAutomationProfile(Base):
    """A project's default delivery method, separate from the plugin catalog.

    A project can keep several approved plugins for exceptional tasks, while this profile makes
    the ordinary path deterministic.  The admin UI therefore asks for a business outcome instead
    of exposing plugin ids, versions and bindings as independent configuration steps.
    """
    __tablename__ = "automation_project_profile"

    project_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    mode: Mapped[str] = mapped_column(String(32), default="standard")
    binding_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    configured_by: Mapped[str] = mapped_column(String(36), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class WorkflowRun(Base):
    """A task's plugin execution, pinned to the version snapshot selected at startup."""
    __tablename__ = "automation_workflow_run"
    __table_args__ = (Index("ix_workflow_task_latest", "task_id", "created_at", "id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    plugin_id: Mapped[str] = mapped_column(String(36), index=True)
    plugin_version_id: Mapped[str] = mapped_column(String(36), index=True)
    binding_id: Mapped[str] = mapped_column(String(36), default="")
    state: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    current_nodes: Mapped[list] = mapped_column(JSON, default=list)
    input: Mapped[dict] = mapped_column(JSON, default=dict)
    output: Mapped[dict] = mapped_column(JSON, default=dict)
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(String(1200), default="")
    initiated_by: Mapped[str] = mapped_column(String(36), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class NodeRun(Base):
    """One typed-node attempt with lease state for recovery after Runner disconnection."""
    __tablename__ = "automation_node_run"
    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uq_automation_node_run_idempotency_key"),
        Index("ix_node_run_attempt", "run_id", "node_key", "attempt"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), index=True)
    node_key: Mapped[str] = mapped_column(String(100), index=True)
    node_type: Mapped[str] = mapped_column(String(32))
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    state: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    input: Mapped[dict] = mapped_column(JSON, default=dict)
    output: Mapped[dict] = mapped_column(JSON, default=dict)
    executor: Mapped[dict] = mapped_column(JSON, default=dict)
    idempotency_key: Mapped[str] = mapped_column(String(180))
    lease_owner: Mapped[str] = mapped_column(String(100), default="")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    error: Mapped[str] = mapped_column(String(1200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class WorkflowOutbox(Base):
    """Transactional outbox storing state changes and pending events together to prevent committed
    transitions from losing messages.
    """
    __tablename__ = "automation_workflow_outbox"
    __table_args__ = (Index("ix_workflow_outbox_due", "status", "available_at", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), index=True)
    node_run_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    topic: Mapped[str] = mapped_column(String(80), index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    available_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    lease_owner: Mapped[str] = mapped_column(String(100), default="")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    error: Mapped[str] = mapped_column(String(1000), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WorkflowEvent(Base):
    """Detailed plugin-run events; task timelines retain only user-relevant summaries."""
    __tablename__ = "automation_workflow_event"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(String(36), index=True)
    node_run_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    kind: Mapped[str] = mapped_column(String(64), index=True)
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    actor: Mapped[str] = mapped_column(String(100), default="system")
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class TaskEvaluation(Base):
    """A person's review of a completed task.

    Evaluation is a task fact, not a workflow node.  Keeping it outside ``WorkflowRun`` means
    direct AI work, human work and plugin-driven delivery all learn through the same contract.
    One evaluator owns one current projection; ``revision`` and TaskEvent retain the audit trail.
    """
    __tablename__ = "automation_task_evaluation"
    __table_args__ = (
        UniqueConstraint("task_id", "evaluator_id", name="uq_task_evaluation_actor"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    evaluator_id: Mapped[str] = mapped_column(String(80), index=True)
    evaluator_name: Mapped[str] = mapped_column(String(80), default="")
    outcome: Mapped[str] = mapped_column(String(16), default="achieved", index=True)
    score: Mapped[int] = mapped_column(Integer, default=5)
    summary: Mapped[str] = mapped_column(Text, default="")
    worked_well: Mapped[str] = mapped_column(Text, default="")
    improvement: Mapped[str] = mapped_column(Text, default="")
    reusable_lesson: Mapped[str] = mapped_column(Text, default="")
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class EvolutionProposal(Base):
    """A controlled improvement proposal derived from task evidence.

    ``accepted`` deliberately does not mutate a live plugin.  Applying an improvement means
    linking it to a different, approved immutable plugin version after that version has passed
    import, preflight and trust review.  This is the safety boundary between learning and drift.
    """
    __tablename__ = "automation_evolution_proposal"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    evaluation_id: Mapped[str] = mapped_column(String(36), index=True)
    project_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    plugin_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    source_plugin_version_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    target_kind: Mapped[str] = mapped_column(String(24), default="knowledge", index=True)
    title: Mapped[str] = mapped_column(String(240), default="")
    problem: Mapped[str] = mapped_column(Text, default="")
    proposal: Mapped[str] = mapped_column(Text, default="")
    evidence: Mapped[dict] = mapped_column(JSON, default=dict)
    state: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    proposed_by: Mapped[str] = mapped_column(String(80), default="")
    reviewed_by: Mapped[str] = mapped_column(String(80), default="")
    reviewed_by_name: Mapped[str] = mapped_column(String(80), default="")
    review_note: Mapped[str] = mapped_column(Text, default="")
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    applied_plugin_version_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    applied_by: Mapped[str] = mapped_column(String(80), default="")
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class RunnerNode(Base):
    """A durable runner identity and its dispatch policy.

    WebSocket presence is deliberately not stored as truth: online state is derived from the
    live hub.  The database keeps operator intent (accepting/draining/disabled) and the last
    reported capabilities so a node remains manageable while offline.
    """
    __tablename__ = "automation_runner_node"
    __table_args__ = (
        # NULL is allowed for legacy shared/operations rows; non-NULL owner
        # values are unique so concurrent creates cannot make two personal
        # environments for one account.
        Index("uq_automation_runner_node_owner_user", "owner_user_id", unique=True),
    )

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    # An independent Runner serves this organization subtree. Embedded client Runners also
    # mirror their authenticated user's organization here, but client_id remains their owner.
    # None is deliberately "unassigned", never "globally shared": tenant dispatch must fail
    # closed until an administrator assigns the node.
    org_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    # An independently enrolled cloud environment belongs to exactly one user.
    # ``NULL`` is retained for legacy shared/operations runners; the unique index
    # therefore permits those old rows while preventing two personal nodes for a
    # single account.
    owner_user_id: Mapped[str | None] = mapped_column(String(36), default=None, index=True)
    client_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    host: Mapped[str] = mapped_column(String(100), default="")
    os: Mapped[str] = mapped_column(String(100), default="")
    version: Mapped[str] = mapped_column(String(40), default="")
    work_root: Mapped[str] = mapped_column(String(700), default="")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    agents: Mapped[list] = mapped_column(JSON, default=list)
    # Substrate-neutral machine facts consumed by work scenarios and plugins.
    # Keep these independent from concrete CLIs such as Pi or Codex.
    capabilities: Mapped[dict] = mapped_column(JSON, default=dict)
    dispatch_mode: Mapped[str] = mapped_column(String(20), default="accepting", index=True)
    # Administrator authority is separate from the owner's pause/resume choice.
    # A transferred identity is permanently retired; its replacement requires
    # clean host provisioning before an administrator can enable it.
    management_state: Mapped[str] = mapped_column(String(24), default="", server_default="")
    # Store only SHA-256 hashes of per-Runner keys; reveal plaintext once when issuing them.
    # Empty auth_state means no per-Runner key, using device authentication or transitional shared credentials.
    # active permits keyed connections; revoked invalidates the key and disconnects current sessions.
    secret_hash: Mapped[str] = mapped_column(String(64), default="")
    auth_state: Mapped[str] = mapped_column(String(16), default="", index=True)
    # Store the user-assigned machine name separately from the reported host name.
    # A heartbeat may update host, and multiple Runners may share the same physical host.
    # Separate display names keep those Runner registrations distinguishable.
    enroll_name: Mapped[str] = mapped_column(String(80), default="")
    busy: Mapped[int] = mapped_column(Integer, default=0)
    max_concurrent: Mapped[int] = mapped_column(Integer, default=1)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ExecutionSession(Base):
    """Runtime-independent execution session indexed by stable ref. Persist history across Runner
    disconnects; task deletion removes sessions and events through domain services. Retain audit
    history through archival rather than orphaned task records.
    """
    __tablename__ = "automation_execution_session"
    __table_args__ = (UniqueConstraint("ref", name="uq_execution_session_ref"),
        Index("ix_execution_task_latest", "task_id", "started_at", "created_at"),
        Index("ix_execution_runner_active", "runner_id", "state", "last_event_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    task_id: Mapped[str] = mapped_column(String(36), index=True)
    workflow_run_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    node_run_id: Mapped[str] = mapped_column(String(36), default="", index=True)
    ref: Mapped[str] = mapped_column(String(180), index=True)
    runner_id: Mapped[str] = mapped_column(String(80), default="", index=True)
    runner_client_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    host: Mapped[str] = mapped_column(String(100), default="")
    engine: Mapped[str] = mapped_column(String(60), default="")
    model: Mapped[str] = mapped_column(String(160), default="")
    state: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    seq: Mapped[int] = mapped_column(Integer, default=0)
    # Transport receipts and replay watermarks are independent from observed seq.
    delivery_stream_id: Mapped[str] = mapped_column(String(64), default="", server_default="")
    delivery_seq: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    delivery_digest: Mapped[str] = mapped_column(String(64), default="", server_default="")
    persisted_seq: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    work_dir: Mapped[str] = mapped_column(String(700), default="")
    metadata_: Mapped[dict] = mapped_column("metadata", JSON, default=dict)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    last_event_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class ExecutionEvent(Base):
    """Replayable session events, idempotent by session and sequence across reconnects."""
    __tablename__ = "automation_execution_event"
    __table_args__ = (
        UniqueConstraint("session_id", "seq", name="uq_execution_event_session_seq"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(String(36), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(32), default="out", index=True)
    tool: Mapped[str] = mapped_column(String(120), default="")
    text: Mapped[str] = mapped_column(Text, default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
